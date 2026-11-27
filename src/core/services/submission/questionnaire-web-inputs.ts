/**
 * One question of a mod_questionnaire web form (complete.php, print.php): its `.qn-container` (number `.qn-number`,
 * prompt `.qn-question-content`, "required" `.qn-required`) and its inputs, all named after the question id
 * (`q<id>`). Mapped by the inputs alone, never by labels:
 *   yes/no    radios `q<id>` valued y / n            radio     radios `q<id>` valued <choice> / other_<choice>
 *   (an optional yes/no or radio question adds a "no answer" radio valued '')
 *   dropdown  `<select name="q<id>">`               checkbox  `q<id>[<choice>]` (or `[o<choice>]` / `[other_<choice>]`)
 *   rate      one radio group per row `q<id>_<row>` text      `<input type="text|date|number|range" name="q<id>">`
 *   essay     `<textarea name="q<id>">` (or `q<id>[text]`)
 *   "other" texts `q<id>_o<choice>`, `q<id>o<choice>` or `q<id>_<choice>` next to a radio / checkbox list
 * Anything else is 'other': this server does not answer it (the caller refuses).
 * Answers are read into the shared field names (questionnaire-fields.ts) and written back from them.
 */

import { InvalidInput } from '../../errors';
import { decodeEntities, htmlToMarkdown } from '../../html';
import { attr, findAll, findFirst, type HtmlElement, text } from '../../moodle/web/html';
import type { QuestionnaireChoice, QuestionnaireQuestion, QuestionnaireQuestionType } from '../../types';
import { answerFrom, fieldKey } from './questionnaire-fields';

type Kind = 'radio' | 'checkbox' | 'select' | 'textarea' | 'text' | 'date' | 'number' | 'range' | 'other';

interface Input {
  kind: Kind;
  name: string;
  value: string;
  id: string;
  checked: boolean;
  el: HtmlElement;
}

/** Where each part of an answer goes on the page. */
interface WebInputs {
  /** Every answer input name of the question (cleared before the answer is set). */
  names: string[];
  /** The field of a single answer (choice or text). */
  single: string | null;
  /** choice id -> the value sent in `single` (radio, yes/no, dropdown). */
  values: Map<string, string>;
  /** choice id -> [name, value] of its checkbox. */
  checks: Map<string, [string, string]>;
  /** choice id -> name of its "other" text input. */
  others: Map<string, string>;
  /** rate row id -> name of its radio group. */
  rows: Map<string, string>;
}

export interface WebQuestion {
  question: QuestionnaireQuestion;
  inputs: WebInputs;
}

const TEXT_KINDS: Record<string, Kind> = { text: 'text', date: 'date', number: 'number', range: 'range' };
const TEXT_TYPES: Partial<Record<Kind, QuestionnaireQuestionType>> = {
  text: 'text',
  date: 'date',
  number: 'numeric',
  range: 'slider',
};
const isOn = (attrs: string, flag: string) => new RegExp(`(?:^|\\s)${flag}(?:\\s|=|$)`, 'i').test(attrs);

function kindOf(el: HtmlElement): Kind | null {
  if (el.tag === 'select') return 'select';
  if (el.tag === 'textarea') return 'textarea';
  if (el.tag !== 'input') return null;
  const type = (attr(el.attrs, 'type') || 'text').toLowerCase();
  if (type === 'hidden' || type === 'submit' || type === 'button') return null;
  if (type === 'radio' || type === 'checkbox') return type;
  return TEXT_KINDS[type] ?? 'other';
}

function inputsOf(html: string): Input[] {
  const out: Input[] = [];
  for (const el of findAll(html, { attr: 'name' })) {
    const kind = kindOf(el);
    const name = attr(el.attrs, 'name');
    if (!kind || !/^q\d+/.test(name)) continue;
    const value = el.tag === 'textarea' ? decodeEntities(el.inner) : attr(el.attrs, 'value');
    out.push({ kind, name, value, id: attr(el.attrs, 'id'), checked: isOn(el.attrs, 'checked'), el });
  }
  return out;
}

const emptyInputs = (names: string[]): WebInputs => ({
  names,
  single: null,
  values: new Map(),
  checks: new Map(),
  others: new Map(),
  rows: new Map(),
});

interface Parsed {
  type: QuestionnaireQuestionType;
  choices: QuestionnaireChoice[];
  scale: QuestionnaireQuestion['scale'];
  range: QuestionnaireQuestion['range'];
  inputs: WebInputs;
  /** The page's current answer: shared field names without the question's key ('' = the key itself, '_o12', …). */
  values: Map<string, string>;
}

/** A choice id from a radio value or checkbox key: `12`, `o12`, `other_12`; `other` tells the "other" choice. */
function choiceKey(raw: string): { id: string; other: boolean } | null {
  const m = /^(o|other_)?(\d+)$/.exec(raw);
  return m?.[2] ? { id: m[2], other: Boolean(m[1]) } : null;
}

/** The "other" text inputs of a choice list: choice id -> input. Null when a text input is not one of them. */
function otherTexts(qid: number, texts: Input[]): Map<string, Input> | null {
  const out = new Map<string, Input>();
  for (const t of texts) {
    const m = new RegExp(`^q${qid}(?:_o|o|_)(\\d+)$`).exec(t.name);
    if (!m?.[1] || t.kind !== 'text') return null;
    out.set(m[1], t);
  }
  return out;
}

function labelsOf(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of findAll(html, { attr: 'for', tag: 'label' })) out.set(attr(l.attrs, 'for'), text(l.inner));
  return out;
}

interface Ctx {
  qid: number;
  html: string;
  inputs: Input[];
  labels: Map<string, string>;
}

const ofKind = (c: Ctx, kind: Kind) => c.inputs.filter((i) => i.kind === kind);
const only = (c: Ctx, ...kinds: Kind[]) => c.inputs.every((i) => kinds.includes(i.kind));

function parsedAs(type: QuestionnaireQuestionType, inputs: WebInputs): Parsed {
  return { type, choices: [], scale: [], range: null, inputs, values: new Map() };
}

/**
 * Radios `q<id>`: yes/no or a radio list (with "other" texts). An optional question adds a "no answer" radio valued
 * '' (checked by default): it is no choice, and the answer replaces it (its name is among the question's names).
 */
function radioList(c: Ctx): Parsed | null {
  const base = `q${c.qid}`;
  const all = ofKind(c, 'radio');
  const radios = all.filter((r) => r.value !== '');
  const others = otherTexts(c.qid, ofKind(c, 'text'));
  if (!others || !only(c, 'radio', 'text') || !radios.length || all.some((r) => r.name !== base)) return null;
  const yesno = radios.every((r) => r.value === 'y' || r.value === 'n');
  const p = parsedAs(yesno ? 'yesno' : 'radio', { ...emptyInputs([base]), single: base });
  for (const r of radios) {
    const k = yesno ? { id: r.value, other: false } : choiceKey(r.value);
    if (!k) return null;
    const other = others.get(k.id);
    p.choices.push({ id: k.id, label: c.labels.get(r.id) || r.value, otherText: k.other || Boolean(other) });
    p.inputs.values.set(k.id, r.value);
    if (other) addOther(p, k.id, other);
    if (r.checked) p.values.set('', k.id);
  }
  return p;
}

function addOther(p: Parsed, id: string, other: Input): void {
  p.inputs.others.set(id, other.name);
  p.inputs.names.push(other.name);
  if (other.value) p.values.set(`_o${id}`, other.value);
}

/** Checkboxes `q<id>[<choice>]` (with "other" texts). */
function checkList(c: Ctx): Parsed | null {
  const others = otherTexts(c.qid, ofKind(c, 'text'));
  if (!others || !only(c, 'checkbox', 'text')) return null;
  const p = parsedAs('checkbox', emptyInputs([]));
  for (const box of ofKind(c, 'checkbox')) {
    const m = new RegExp(`^q${c.qid}\\[([^\\]]+)\\]$`).exec(box.name);
    const k = m?.[1] ? choiceKey(m[1]) : null;
    if (!k) return null;
    const other = others.get(k.id);
    p.choices.push({ id: k.id, label: c.labels.get(box.id) || box.value, otherText: k.other || Boolean(other) });
    p.inputs.checks.set(k.id, [box.name, box.value || '1']);
    p.inputs.names.push(box.name);
    if (other) addOther(p, k.id, other);
    if (box.checked) p.values.set(`_${k.id}`, '1');
  }
  return p;
}

function dropdown(c: Ctx): Parsed | null {
  const [select] = ofKind(c, 'select');
  if (!select || c.inputs.length !== 1 || select.name !== `q${c.qid}`) return null;
  const p = parsedAs('dropdown', { ...emptyInputs([select.name]), single: select.name });
  for (const o of findAll(select.el.inner, { attr: 'value', tag: 'option' })) {
    const value = attr(o.attrs, 'value');
    if (!value) continue;
    p.choices.push({ id: value, label: text(o.inner), otherText: false });
    p.inputs.values.set(value, value);
    if (isOn(o.attrs, 'selected')) p.values.set('', value);
  }
  return p;
}

/** One text-like input (`q<id>`, or an editor's `q<id>[text]`). */
function single(c: Ctx): Parsed | null {
  const [input] = c.inputs;
  if (!input || c.inputs.length !== 1) return null;
  const essay = input.kind === 'textarea';
  const named = input.name === `q${c.qid}` || (essay && input.name === `q${c.qid}[text]`);
  const type = essay ? 'essay' : TEXT_TYPES[input.kind];
  if (!named || !type) return null;
  const p = parsedAs(type, { ...emptyInputs([input.name]), single: input.name });
  if (type === 'slider') p.range = rangeOf(input.el.attrs);
  // a slider always carries a value: it says nothing about an answer
  else if (input.value) p.values.set('', input.value);
  return p;
}

function rangeOf(attrs: string): QuestionnaireQuestion['range'] {
  const n = (name: string) => Number(attr(attrs, name) || Number.NaN);
  const [min, max, step] = [n('min'), n('max'), n('step')];
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max, step: Number.isFinite(step) && step > 0 ? step : 1 };
}

const CELL = /<t[dh](?=[\s>])[^>]*>([\s\S]*?)<\/t[dh]>/gi;
const cellsOf = (row: string): string[] => [...row.matchAll(CELL)].map((m) => text(m[1] ?? ''));

/** A rating grid: a table row per item, a radio group `q<id>_<row>` in each; the head row names the scale. */
function rateGrid(c: Ctx): Parsed | null {
  const radios = ofKind(c, 'radio');
  const rowOf = (name: string) => new RegExp(`^q${c.qid}_(\\d+)$`).exec(name)?.[1];
  if (!radios.length || !only(c, 'radio') || radios.some((r) => !rowOf(r.name))) return null;
  const rows = c.html.split(/<tr(?=[\s>])/i).slice(1);
  const heads = cellsOf(rows.find((r) => /<th(?=[\s>])/i.test(r) && !r.includes('type="radio"')) ?? '');
  const p = parsedAs('rate', emptyInputs([]));
  for (const r of radios) {
    const row = rowOf(r.name) ?? '';
    if (!p.inputs.rows.has(row)) {
      const label = cellsOf(rows.find((x) => x.includes(`name="${r.name}"`)) ?? '')[0] ?? '';
      p.choices.push({ id: row, label: label || row, otherText: false });
      p.inputs.rows.set(row, r.name);
      p.inputs.names.push(r.name);
    }
    if (r.checked) p.values.set(`_${row}`, r.value);
  }
  const first = radios.filter((r) => r.name === p.inputs.rows.values().next().value);
  p.scale = first.map((r, i) => ({ value: r.value, label: heads[heads.length - first.length + i] || r.value }));
  return p;
}

function classify(c: Ctx): Parsed | null {
  if (c.inputs.some((i) => i.kind === 'radio')) return radioList(c) ?? rateGrid(c);
  if (c.inputs.some((i) => i.kind === 'checkbox')) return checkList(c);
  if (c.inputs.some((i) => i.kind === 'select')) return dropdown(c);
  return single(c);
}

const byClass = (html: string, cls: string) => findFirst(html, { attr: 'class', value: cls, word: true });

/**
 * What a `.qn-container` shows of its question whatever renders it (form, printable copy, submitted response): the
 * number `.qn-number`, the prompt `.qn-question-content` and the required marker `.qn-required`. Type 'other', no
 * choices and no answer yet.
 */
export function questionHead(container: string, id: number, page: number): QuestionnaireQuestion {
  // the prompt itself; `.qn-question` also holds the required marker's hidden text
  const promptHtml = byClass(container, 'qn-question-content')?.inner ?? byClass(container, 'qn-question')?.inner ?? '';
  return {
    id,
    page,
    number: text(byClass(container, 'qn-number')?.inner ?? '') || null,
    type: 'other',
    required: byClass(container, 'qn-required') !== null,
    prompt: htmlToMarkdown(promptHtml, { maxChars: 2000 }),
    choices: [],
    scale: [],
    range: null,
    answer: null,
  };
}

const requiredInput = (inputs: Input[]): boolean =>
  inputs.some((i) => isOn(i.el.attrs, 'required') || attr(i.el.attrs, 'aria-required') === 'true');

/** The question in a `.qn-container`; null when it has no answer input (section text, a submitted response). */
export function webQuestion(container: string, page: number): WebQuestion | null {
  const inputs = inputsOf(container);
  const qid = Number(/^q(\d+)/.exec(inputs[0]?.name ?? '')?.[1]);
  if (!inputs.length || !Number.isSafeInteger(qid)) return null;
  const head = questionHead(container, qid, page);
  const base: QuestionnaireQuestion = { ...head, required: head.required || requiredInput(inputs) };
  const sameQuestion = inputs.every((i) => new RegExp(`^q${qid}(?![0-9])`).test(i.name));
  const parsed = sameQuestion ? classify({ qid, html: container, inputs, labels: labelsOf(container) }) : null;
  if (!parsed) return { question: base, inputs: emptyInputs(inputs.map((i) => i.name)) };
  const { type, choices, scale, range } = parsed;
  const q: QuestionnaireQuestion = { ...base, type, choices, scale, range };
  const key = fieldKey(q) ?? '';
  const values = new Map([...parsed.values].map(([suffix, v]) => [key + suffix, v]));
  return { question: { ...q, answer: answerFrom(q, key, values) }, inputs: parsed.inputs };
}

// ------------------------------------------------------------------ shared fields -> page fields

const ownKey = (key: string) => (k: string) => k === key || k.startsWith(`${key}_`);

function pageField(w: WebQuestion, key: string, [k, v]: [string, string]): [string, string] | null {
  const { inputs, question } = w;
  if (k === key) {
    if (!inputs.single) return null;
    if (!inputs.values.size) return [inputs.single, v];
    const value = inputs.values.get(v);
    return value === undefined ? null : [inputs.single, value];
  }
  const rest = k.slice(key.length + 1);
  const other = /^o(\d+)$/.exec(rest)?.[1];
  const name = other ? inputs.others.get(other) : inputs.rows.get(rest);
  if (name) return [name, v];
  return question.type === 'checkbox' ? (inputs.checks.get(rest) ?? null) : null;
}

/**
 * The page's own fields for the answers `fields` gives this question (shared names); the keys used are removed from
 * `fields`. Throws when an answer has no input on the page (the form changed since the answers were checked).
 */
export function pageFieldsFor(w: WebQuestion, fields: Map<string, string>): Array<[string, string]> {
  const key = fieldKey(w.question);
  const out: Array<[string, string]> = [];
  if (!key) return out;
  for (const entry of [...fields].filter(([k]) => ownKey(key)(k))) {
    const field = pageField(w, key, entry);
    if (!field) {
      const id = w.question.id;
      throw new InvalidInput(`Question ${id} changed in Moodle since the answers were checked; prepare again.`);
    }
    out.push(field);
    fields.delete(entry[0]);
  }
  return out;
}

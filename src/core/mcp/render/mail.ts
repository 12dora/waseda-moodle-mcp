import { formatBytes } from '../../format';
import type {
  MailAttachment,
  MailMessage,
  MailSearchHit,
  MailSearchResult,
  MailThread,
} from '../../services/mail/read';
import { fmt } from '../../time';
import { assemble, assembleTail, oneLine, plural } from './common';

/** Matches the get_mail structured budget (12k per message is applied in the service). */
const MAIL_TEXT_BUDGET = 40_000;

function searchLine(m: MailSearchHit): string {
  const unread = m.unread ? '[unread] ' : '';
  const att = m.hasAttachments ? ' [attachment]' : '';
  const who = `${oneLine(m.from, 40)} → ${oneLine(m.to, 40)}`;
  const ids = `thread_id ${m.threadId}, message_id ${m.id}`;
  const head = `- ${unread}${fmt(m.date)} · ${who} — ${oneLine(m.subject, 80)}${att} (${ids})`;
  return m.snippet ? `${head}\n  ${oneLine(m.snippet, 160)}` : head;
}

export function renderMailSearch(r: MailSearchResult): string {
  if (r.messages.length === 0) return 'No matching Waseda mail.';
  const footer = r.nextPageToken ? [`More: call search_mail again with page_token ${r.nextPageToken}.`] : [];
  const open = 'newest first; open one with get_mail using thread_id';
  return assemble({
    head: [`${plural(r.messages.length, 'message')} in Waseda mail (${open}):`],
    entries: r.messages.map((m) => ({ text: searchLine(m), item: true })),
    footer,
    hint: 'narrow the query or lower limit',
  });
}

function attachmentLine(a: MailAttachment): string {
  const size = formatBytes(a.size);
  const name = oneLine(a.filename, 80);
  if (a.url) return `- ${name} (${size}) — ${a.url}`;
  return `- ${name} (${size}) — ${a.note ?? 'Open it in Gmail.'}`;
}

const CUT_HINT = 'full text in structured result / open in Gmail.';

function cutNote(shown: number, total: number): string {
  return `body cut at ${shown} of ${total} chars; ${CUT_HINT}`;
}

function messageBlock(m: MailMessage): string {
  const unread = m.unread ? ' [unread]' : '';
  const cc = m.cc ? ` (cc ${oneLine(m.cc, 40)})` : '';
  const who = `${oneLine(m.from, 50)} → ${oneLine(m.to, 50)}${cc}`;
  const lines = [`${fmt(m.date)} · ${who} — ${oneLine(m.subject, 80)}${unread} (message_id ${m.id})`];
  if (m.note) lines.push(m.note);
  if (m.text) lines.push(m.text);
  if (m.truncated) lines.push(`body cut at ${m.text.length} chars; ${CUT_HINT}`);
  for (const a of m.attachments) lines.push(attachmentLine(a));
  return lines.join('\n');
}

export function renderMail(t: MailThread): string {
  const omit = t.omitted > 0 ? `, ${t.omitted} older omitted` : '';
  const head = [
    `# ${oneLine(t.subject, 120) || '(no subject)'}`,
    `${plural(t.messages.length, 'message')}${omit}. Open in Gmail: ${t.webUrl}`,
  ];
  const footer = ['Reply with prepare_mail_reply using the message_id of the message to answer.'];
  return assembleTail({
    head,
    blocks: t.messages.map(messageBlock),
    footer,
    noun: t.messages.length === 1 ? 'message' : 'messages',
    budget: MAIL_TEXT_BUDGET,
    onCut: cutNote,
  });
}

/**
 * Synthetic JAA104 pages shaped like the public ones (two label sets, nested session / grading tables, the unclosed
 * `<tr>` some pages have, free text where others use tables). Names and content are invented.
 */

const infoRow = (label: string, value: string, colspan = 5) =>
  `<tr><th width="12%" scope="row" colspan="2">${label}</th>\n<td colspan="${colspan}">${value}</td></tr>`;
const textRow = (label: string, html: string) =>
  `<tr><th width="20%" scope="row">${label}</th>\n<td class="wysiwyg">${html}</td></tr>`;

interface Labels {
  year: string;
  school: string;
  title: string;
  instructor: string;
  term: string;
  category: string;
  credits: string;
  classroom: string;
  campus: string;
  language: string;
  modality: string;
  subtitle: string;
  outline: string;
  objectives: string;
  prepost: string;
  plan: string;
  textbooks: string;
  references: string;
  evaluation: string;
  rate: string;
  criteria: string;
  notes: string;
  updated: string;
}

const JA: Labels = {
  year: '開講年度',
  school: '開講箇所',
  title: '科目名',
  instructor: '担当教員',
  term: '学期曜日時限',
  category: '科目区分',
  credits: '単位数',
  classroom: '使用教室',
  campus: 'キャンパス',
  language: '授業で使用する言語',
  modality: '授業方法区分',
  subtitle: '副題',
  outline: '授業概要',
  objectives: '授業の到達目標',
  prepost: '事前・事後学習の内容',
  plan: '授業計画',
  textbooks: '教科書',
  references: '参考文献',
  evaluation: '成績評価方法',
  rate: '割合',
  criteria: '評価基準',
  notes: '備考・関連URL',
  updated: '最終更新日時：',
};

const EN: Labels = {
  year: 'Year',
  school: 'School',
  title: 'Course Title',
  instructor: 'Instructor',
  term: 'Term/Day/Period',
  category: 'Category',
  credits: 'Credits',
  classroom: 'Classroom',
  campus: 'Campus',
  language: 'Main Language',
  modality: 'Class Modality Categories',
  subtitle: 'Subtitle',
  outline: 'Course Outline',
  objectives: 'Objectives',
  prepost: 'before/after course of study',
  plan: 'Course Schedule',
  textbooks: 'Textbooks',
  references: 'Reference',
  evaluation: 'Evaluation',
  rate: 'Rate',
  criteria: 'Evaluation Criteria',
  notes: 'Note/URL',
  updated: 'Latest Update：',
};

const session = (no: number, title: string, topics: string[]) =>
  `<tr>\n<td nowrap="nowrap" valign="top" style="text-align:right;">${no}:</td>\n<td width="600" value="top">\n` +
  `<table><tbody><tr><td>${title}</td></tr><tr><td>${topics.map((t) => `<div>${t}&nbsp;</div>`).join('')}</td></tr></tbody></table>\n` +
  '</td>\n</tr>';

const gradeRow = (method: string, rate: string, criteria: string) =>
  `<tr><td nowrap="nowrap" valign="top" style="text-align:right;">${method}:</td>\n<td align="center" valign="top">\n${rate}\n</td>\n<td width="90%">${criteria}</td></tr>`;

interface Content {
  title: string;
  instructor: string;
  term: string;
  room: string;
  campus: string;
  language: string;
  modality: string;
  subtitle: string;
  outline: string;
  objectives: string;
  prepost: string;
  sessions: Array<[string, string[]]>;
  textbooks: string;
  references: string;
  grading: Array<[string, string, string]>;
  notes: string;
}

function tablePage(l: Labels, c: Content): string {
  return (
    '<html lang="ja"><body><div id="cHonbun"><div class="ctable-main"><h2 class="c-kadd-t"><span>x</span></h2>' +
    '<table class="ct-common ct-sirabasu" summary="table"><tbody>' +
    `<tr><th width="20%" scope="row" colspan="2">${l.year}</th>\n<td width="32%">2026&nbsp;</td>\n` +
    `<th width="12%" scope="row">${l.school}</th>\n<td colspan="3">Sample School</td></tr>` +
    infoRow(l.title, `<div>${c.title}</div><p></p>`) +
    infoRow(l.instructor, c.instructor) +
    infoRow(l.term, c.term) +
    `<tr><th width="12%" scope="row" colspan="2">${l.category}</th>\n<td width="21%">Elective</td>\n` +
    `<th width="12%" scope="row">${l.credits}</th>\n<td>2</td></tr>` +
    `<tr><th width="12%" scope="row" colspan="2">${l.classroom}</th>\n<td width="32%">${c.room}</td>\n` +
    `<th width="12%" scope="row">${l.campus}</th>\n<td colspan="3">${c.campus}</td></tr>` +
    '<tr>\n' +
    `<th width="12%" scope="row" colspan="2">${l.language}</th>\n<td colspan="5">${c.language}</td>\n</tr>` +
    infoRow(l.modality, c.modality) +
    '<tr><th width="10%" rowspan="5" class="course-code-group">&nbsp;</th>\n' +
    '<th width="10%" scope="row" class="course-code-main">Code</th>\n<td colspan="5">ABCX101L</td></tr>' +
    '</tbody></table></div>\n<div class="cbd-bkbottom"><div> </div></div></div>\n' +
    '<div class="c-mblock"><div class="ctable-main"><div style="position: relative;">' +
    `<h2 class="c-kadd-t">${l.updated}2026/05/15 12:37:49</h2></div>\n` +
    '<table class="ct-common ct-sirabasu" summary="table"><tbody>' +
    textRow(l.subtitle, c.subtitle) +
    textRow(l.outline, c.outline) +
    textRow(l.objectives, c.objectives) +
    textRow(l.prepost, c.prepost) +
    `<tr><th width="20%" scope="row">\n${l.plan}\n</th>\n<td><table><tbody>\n${c.sessions.map(([title, topics], i) => session(i + 1, title, topics)).join('\n')}\n</tbody></table></td></tr>` +
    textRow(l.textbooks, c.textbooks) +
    textRow(l.references, c.references) +
    `<tr>\n<th width="20%" scope="row">${l.evaluation}</th>\n<td><table border="0" width="100%" summary="table">\n` +
    `<tr class="c-vh-title"><th width="16%" colspan="2">${l.rate}</th><th align="center">${l.criteria}</th></tr>\n` +
    `${c.grading.map(([m, r, k]) => gradeRow(m, r, k)).join('\n')}\n</table></td></tr>` +
    textRow(l.notes, c.notes) +
    '</tbody></table></div>\n<div class="cbd-bkbottom"><div></div></div></div></div></body></html>'
  );
}

export const JA_PAGE = tablePage(JA, {
  title: 'サンプル経営論',
  instructor: '山田太郎、Sample Teacher',
  term: '秋クォーター&nbsp;&nbsp;水３-４',
  room: '99-101（教室）',
  campus: '早稲田',
  language: '日本語',
  modality: '【対面】',
  subtitle: '事例で学ぶ',
  outline: '企業の戦略を学ぶ。<br><br>事例を使って議論する。',
  objectives: '・戦略を説明できる<br />・事例を分析できる',
  prepost: '事前：教科書を読む。<br />事後：小テストを解く。',
  sessions: [
    ['第1回 ガイダンス', ['授業の進め方', '評価方法']],
    ['第2回 戦略の基礎', ['競争優位']],
    ['第3回 事例研究', []],
  ],
  textbooks: '山田太郎『サンプル経営論』架空出版、2025年。',
  references: '授業中に指示する。',
  grading: [
    ['試験', '60％', '第14回に実施する。<br />持ち込み不可。'],
    ['平常点評価', '40％', '毎回の小テスト。'],
  ],
  notes: '<p>質問は授業後に受け付けます。 https://example.com/info</p>',
});

export const EN_PAGE = tablePage(EN, {
  title: 'Sample Strategy',
  instructor: 'YAMADA, Taro',
  term: 'fall quarter&nbsp;&nbsp;Wed.3-4',
  room: '99-101',
  campus: 'waseda',
  language: 'English',
  modality: '[On-campus]',
  subtitle: '',
  outline: 'Firm strategy through cases.',
  objectives: 'Explain strategy.<br>Analyse cases.',
  prepost: 'Read the chapter before class.',
  sessions: [
    ['Vol. 1 Introduction', ['Rules of the course']],
    ['Vol. 2 Basics', ['Advantage']],
  ],
  textbooks: 'Taro Yamada, “Sample Strategy”, Example Press, 2025',
  references: 'To be announced.',
  grading: [
    ['Exam', '50％', 'Individual'],
    ['Class Participation', '10％', 'Discussion'],
    ['Others', '40％', 'Group<br />Presentation'],
  ],
  notes: 'Office hours after class.',
});

/** A 総合日本語-style page: weekly plan and grading are free text, the plan row is left unclosed. */
export const FREE_TEXT_PAGE =
  '<html><body><div class="ctable-main"><table class="ct-common ct-sirabasu"><tbody>' +
  infoRow(JA.title, 'サンプル日本語') +
  infoRow(JA.term, '春学期&nbsp;&nbsp;月２') +
  '</tbody></table></div>\n<div class="cbd-bkbottom"></div>' +
  '<table class="ct-common ct-sirabasu"><tbody>' +
  textRow(JA.outline, '<p>自分について書く。</p>') +
  '<tr>\n<th width="20%" scope="row">\n授業計画\n</th>\n<td>\n<br><div>第1週　ガイダンス</div><div>　　【事前・事後学修】　シラバスを読む。</div>' +
  '<div><br>第2週　小エッセイ(1)</div></td>\n<tr>\n<tr>' +
  textRow(JA.textbooks, 'ありません。') +
  textRow(JA.references, 'なし') +
  textRow(JA.evaluation, 'レポート　40％<br />平常点　30％ :  貢献度<br />相互評価　30％') +
  '</tbody></table>\n<div class="cbd-bkbottom"></div></body></html>';

export const EMPTY_PAGE = '<html><body><p>参照可能なシラバス情報はありません。</p></body></html>';
export const ERROR_PAGE = '<html><body><h1>システムエラー</h1></body></html>';

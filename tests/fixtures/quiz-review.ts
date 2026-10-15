/**
 * Synthetic mod_quiz_get_attempt_review / mod_quiz_get_user_quiz_attempts payloads (structure follows Moodle 5.1;
 * every id, name and answer is invented).
 */

const SCRIPT_TAIL =
  '<script>\n//<![CDATA[\nvar require = {baseUrl: "https://moodle.example.com/lib/requirejs.php/1/", waitSeconds: 0};\n//]]>\n</script>';

/** The wrapper Moodle puts around every reviewed question: info block, formulation, outcome, JS bootstrap. */
interface QueParts {
  slot: number;
  type: string;
  correctness: string;
  formulation: string;
  outcome: string;
}

function queHtml(o: QueParts): string {
  const n = `q9001:${o.slot}_`;
  return (
    `<div id="question-9001-${o.slot}" class="que ${o.type} deferredfeedback ${o.correctness}">` +
    `<div class="info"><h3 class="no">Question <span class="qno">${o.slot}</span></h3>` +
    '<div class="state">STATE-LABEL</div><div class="grade">GRADE-LABEL</div>' +
    `<div class="questionflag editable"><input type="hidden" name="${n}:flagged" value="0" />` +
    `<input type="checkbox" id="${n}:flaggedcheckbox" name="${n}:flagged" value="1" /></div></div>` +
    `<div class="content"><div class="formulation clearfix"><h4 class="accesshide">Question text</h4>` +
    `<input type="hidden" name="${n}:sequencecheck" value="3" />${o.formulation}</div>` +
    `<div class="outcome clearfix"><h4 class="accesshide">Feedback</h4>${o.outcome}</div></div></div>${SCRIPT_TAIL}`
  );
}

const CHECK = '<i class="icon fa-regular fa-circle-check text-success fa-fw " title="Correct" role="img"></i>';
const CROSS = '<i class="icon fa-regular fa-circle-xmark text-danger fa-fw " title="Incorrect" role="img"></i>';

const option = (i: number, label: string, checked: boolean, mark = '') =>
  `<div class="r${i % 2}"><input type="radio" name="q9001:1_answer" disabled="disabled" value="${i}" ` +
  `id="q9001:1_answer${i}"${checked ? ' checked="checked"' : ''} />` +
  `<div class="d-flex w-auto" id="q9001:1_answer${i}_label"><span class="answernumber">${'abc'[i]}. </span>` +
  `<div class="flex-fill ms-1"><p>${label}</p></div></div> ${mark ? `<span class="ms-1">${mark}</span>` : ''}</div>`;

export const multichoiceRight = {
  slot: 1,
  type: 'multichoice',
  page: 0,
  questionnumber: '1',
  number: 1,
  state: 'gradedright',
  status: 'Correct',
  mark: '1',
  maxmark: 1,
  html: queHtml({
    slot: 1,
    type: 'multichoice',
    correctness: 'correct',
    formulation:
      '<div class="qtext"><div class="clearfix"><p>Which city is the capital of France?</p></div></div>' +
      '<fieldset class="ablock no-overflow visual-scroll-x"><legend class="prompt h6 fw-normal visually-hidden">' +
      '<span class="visually-hidden">Question 1</span> Answer</legend><div class="answer">' +
      `${option(0, 'Paris', true, CHECK)}\n${option(1, 'Berlin', false)}\n${option(2, 'Madrid', false)}` +
      '</div></fieldset>',
    outcome:
      '<div class="feedback"><div class="specificfeedback clearfix">Your answer is correct.</div>' +
      '<div class="rightanswer">The correct answer is: <p>Paris</div></div>',
  }),
};

export const shortanswerWrong = {
  slot: 2,
  type: 'shortanswer',
  page: 0,
  questionnumber: '2',
  number: 2,
  state: 'gradedwrong',
  status: 'Incorrect',
  mark: '0',
  maxmark: 1,
  html: queHtml({
    slot: 2,
    type: 'shortanswer',
    correctness: 'incorrect',
    formulation:
      '<div class="qtext"><p>The capital of <b>Japan</b> is:</p></div><div class="ablock">' +
      '<label for="q9001:2_answer" class="sr-only">Answer</label><span class="answer">' +
      '<input type="text" name="q9001:2_answer" value="Kyoto" size="30" disabled="disabled" class="incorrect" />' +
      ` ${CROSS}` +
      '</span></div>',
    outcome:
      '<div class="feedback"><div class="specificfeedback">Your answer is incorrect.</div>' +
      '<div class="rightanswer">The correct answer is: Tokyo</div></div>' +
      '<div class="generalfeedback"><p>Tokyo has been the capital since 1868.</p></div>',
  }),
};

export const matchPartial = {
  slot: 3,
  type: 'match',
  page: 0,
  questionnumber: '3',
  number: 3,
  state: 'gradedpartial',
  status: 'Partially correct',
  mark: '0.50',
  maxmark: 1,
  html: queHtml({
    slot: 3,
    type: 'match',
    correctness: 'partiallycorrect',
    formulation:
      '<div class="qtext"><p>Match each country with its capital.</p></div><table class="answer"><tbody>' +
      '<tr class="r0"><td class="text">France</td><td class="control"><select class="select" disabled="disabled">' +
      '<option value="0">Choose...</option><option selected="selected" value="1">Paris</option>' +
      '<option value="2">Rome</option></select></td></tr>' +
      '<tr class="r1"><td class="text">Italy</td><td class="control"><select class="select" disabled="disabled">' +
      '<option value="0">Choose...</option><option value="1">Paris</option>' +
      '<option selected="selected" value="2">Madrid</option></select></td></tr></tbody></table>',
    outcome: '<div class="feedback"><div class="rightanswer">France → Paris, Italy → Rome</div></div>',
  }),
};

export const essayPending = {
  slot: 4,
  type: 'essay',
  page: 1,
  questionnumber: '4',
  number: 4,
  state: 'needsgrading',
  status: 'Requires grading',
  mark: null,
  maxmark: 5,
  html: queHtml({
    slot: 4,
    type: 'essay',
    correctness: '',
    formulation:
      '<div class="qtext"><p>Explain the pricing of a zero-coupon bond.</p></div><div class="ablock">' +
      '<div class="answer"><div class="qtype_essay_response readonly"><p>Discount the face value.</p>' +
      '<p>Use the yield to maturity.</p></div></div></div>',
    outcome: '',
  }),
};

/** A question whose review options hide marks, feedback and the right answer. */
export const hiddenOptions = {
  slot: 5,
  type: 'truefalse',
  page: 1,
  questionnumber: '5',
  number: 5,
  state: 'complete',
  status: 'Answer saved',
  maxmark: 1,
  html: queHtml({
    slot: 5,
    type: 'truefalse',
    correctness: '',
    formulation:
      '<div class="qtext"><p>Bonds are issued by governments.</p></div><div class="ablock"><div class="answer">' +
      '<div class="r0"><input type="radio" value="1" checked="checked" disabled="disabled" />' +
      '<div class="d-flex"><span class="answernumber"></span><div class="flex-fill"><p>True</p></div></div></div>' +
      '<div class="r1"><input type="radio" value="0" disabled="disabled" />' +
      '<div class="d-flex"><span class="answernumber"></span><div class="flex-fill"><p>False</p></div></div></div>' +
      '</div></div>',
    outcome: '',
  }),
};

export const reviewQuestions = [multichoiceRight, shortanswerWrong, matchPartial, essayPending];

export const reviewPayload = {
  grade: 9,
  attempt: { id: 502, quiz: 6001, attempt: 2, state: 'finished', sumgrades: 18 },
  additionaldata: [],
  questions: reviewQuestions,
  warnings: [],
};

/** Raw mod_quiz_get_user_quiz_attempts rows: two finished attempts and one still in progress. */
export const reviewAttempts = [
  { id: 501, attempt: 1, state: 'finished', timestart: 1791860400, timefinish: 1791864000, sumgrades: 15, preview: 0 },
  { id: 502, attempt: 2, state: 'finished', timestart: 1791870000, timefinish: 1791873600, sumgrades: 18, preview: 0 },
  { id: 503, attempt: 3, state: 'inprogress', timestart: 1791939600, timefinish: 0, sumgrades: null, preview: 0 },
];

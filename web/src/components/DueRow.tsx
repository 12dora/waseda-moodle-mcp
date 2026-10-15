import type { DueItem } from '../api/types';
import { type MessageKey, useI18n } from '../i18n';
import { isSubmitted } from '../lib/due';
import { formatDateTime } from '../lib/time';

const SOURCE_LABEL: Record<DueItem['source'], MessageKey> = {
  calendar: 'due.source.calendar',
  activity: 'due.group.undated',
  text: 'due.source.text',
};

/** Note for a handed-in item Moodle still lets the user change: edit the submission or answer again. */
const CONTINUE_NOTE: Partial<Record<DueItem['kind'], MessageKey>> = {
  assign: 'due.sub.canEdit',
  quiz: 'due.sub.again',
  questionnaire: 'due.sub.again',
};

function ContinueNote({ item }: { item: DueItem }) {
  const { t } = useI18n();
  const key = CONTINUE_NOTE[item.kind];
  if (!key || !isSubmitted(item) || !item.submission?.canContinue) return null;
  return <span className="muted small">{t(key)}</span>;
}

function Status({ item }: { item: DueItem }) {
  const { t } = useI18n();
  if (isSubmitted(item)) return null;
  if (item.closed) return <span className="badge">{t('due.closed')}</span>;
  if (item.overdue) return <span className="badge badge-danger">{t('due.group.overdue')}</span>;
  if (item.notOpenYet) return <span className="badge">{t('due.notOpen')}</span>;
  return null;
}

const SUBMISSION_BADGE: Partial<Record<NonNullable<DueItem['submission']>['status'], [MessageKey, string]>> = {
  draft: ['due.sub.draft', 'badge badge-warn'],
  'in-progress': ['due.sub.inProgress', 'badge badge-warn'],
  reopened: ['due.sub.reopened', 'badge'],
};

function SubmissionBadge({ item }: { item: DueItem }) {
  const { t, lang } = useI18n();
  if (isSubmitted(item)) {
    const at = item.submission?.submittedAt ?? null;
    return (
      <span className="badge badge-ok" title={at ? formatDateTime(at, lang) : undefined}>
        {t('due.sub.submitted')}
      </span>
    );
  }
  const entry = item.submission ? SUBMISSION_BADGE[item.submission.status] : undefined;
  if (!entry) return null;
  return <span className={entry[1]}>{t(entry[0])}</span>;
}

function When({ item }: { item: DueItem }) {
  const { t, lang } = useI18n();
  if (item.dueAt) {
    return (
      <time
        dateTime={item.dueAt}
        className={item.overdue && !item.closed && !isSubmitted(item) ? 'text-danger' : undefined}
      >
        {formatDateTime(item.dueAt, lang, { deadline: true })}
      </time>
    );
  }
  if (item.opensAt) {
    return <time dateTime={item.opensAt}>{t('due.opens', { time: formatDateTime(item.opensAt, lang) })}</time>;
  }
  return <span className="muted">-</span>;
}

/** Text-derived deadlines are guesses: show the quote and where it came from so the student can verify. */
function Evidence({ item }: { item: DueItem }) {
  const { t } = useI18n();
  if (item.source !== 'text' || !item.evidence) return null;
  return (
    <div className="due-evidence">
      <q>{item.evidence}</q>{' '}
      <a href={item.sourceUrl ?? item.url} target="_blank" rel="noopener noreferrer">
        {t('due.openSource')}
      </a>
    </div>
  );
}

export function DueRow({ item, showCourse = true }: { item: DueItem; showCourse?: boolean }) {
  const { t } = useI18n();
  const done = isSubmitted(item);
  return (
    <li className={`due-row${item.closed ? ' row-muted' : ''}${done ? ' due-row-done' : ''}`}>
      <div className="due-main">
        <a href={item.url} target="_blank" rel="noopener noreferrer" className="due-name">
          {item.name}
        </a>
        <div className="due-meta">
          {item.isNew && <span className="badge badge-new">{t('due.new')}</span>}
          <span className="tag">{t(`kind.${item.kind}`)}</span>
          <span className={`tag tag-source-${item.source}`}>{t(SOURCE_LABEL[item.source])}</span>
          {showCourse && <span className="due-course">{item.courseName}</span>}
          <ContinueNote item={item} />
        </div>
        <Evidence item={item} />
      </div>
      <div className="due-when">
        <When item={item} />
        <SubmissionBadge item={item} />
        <Status item={item} />
      </div>
    </li>
  );
}

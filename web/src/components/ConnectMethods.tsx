import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ConnectRequest } from '../api/types';
import { useT } from '../i18n';
import { bookmarkletHref } from '../lib/bookmarklet';
import { errorText } from '../lib/errors';
import { useConfig } from '../session';
import { Button } from './Button';
import { Card } from './Card';

/**
 * Draggable bookmarklet link. React 19 refuses javascript: URLs in JSX, so the anchor is created directly;
 * clicking it on this page does nothing (it must be dragged to the bookmarks bar).
 */
function BookmarkletLink({ href, label }: { href: string; label: string }) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const a = document.createElement('a');
    a.className = 'bookmarklet';
    a.href = href;
    a.textContent = label;
    a.addEventListener('click', (e) => e.preventDefault());
    wrap.replaceChildren(a);
  }, [href, label]);
  return <span ref={wrapRef} className="bookmarklet-wrap" />;
}

function passportOf(launchUrl: string): string | undefined {
  try {
    return new URL(launchUrl).searchParams.get('passport') ?? undefined;
  } catch {
    return undefined;
  }
}

/** The ways to hand the Moodle launch link to the service (contract §6, §8, §11). */
export function ConnectMethods({ onConnect }: { onConnect: (body: ConnectRequest) => Promise<void> }) {
  const t = useT();
  const config = useConfig();
  const pasteId = useId();
  const [launch, setLaunch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const href = useMemo(
    () => bookmarkletHref(config.publicUrl, { signin: t('connect.bm.alertSignin'), fail: t('connect.bm.alertFail') }),
    [config.publicUrl, t],
  );
  const passport = useMemo(() => passportOf(config.launchUrl), [config.launchUrl]);

  const submitPaste = async (e: FormEvent) => {
    e.preventDefault();
    const value = launch.trim();
    if (!value) {
      setError(t('connect.paste.required'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConnect({ launch: value, via: 'paste', passport });
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <Card title={t('connect.bm.title')}>
        <ol className="steps">
          <li>
            {t('connect.bm.step1')}
            <div>
              <BookmarkletLink href={href} label={t('connect.bm.link')} />
            </div>
          </li>
          <li>
            {t('connect.bm.step2')}{' '}
            <a href={`${config.moodleUrl.replace(/\/+$/, '')}/my/`} target="_blank" rel="noopener noreferrer">
              Waseda Moodle
            </a>
          </li>
          <li>{t('connect.bm.step3')}</li>
        </ol>
        <p className="muted small">{t('connect.phoneHint')}</p>
      </Card>

      {config.extensionUrl && (
        <Card title={t('connect.ext.title')}>
          <p className="muted">{t('connect.ext.desc')}</p>
          <a className="btn btn-secondary" href={config.extensionUrl} target="_blank" rel="noopener noreferrer">
            {t('connect.ext.install')}
          </a>
        </Card>
      )}

      <Card title={t('connect.paste.title')}>
        <form className="stack" onSubmit={submitPaste} noValidate>
          <ol className="steps">
            <li>
              {t('connect.paste.step1')}
              <div>
                <a
                  className="btn btn-secondary btn-sm"
                  href={config.launchUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('connect.paste.open')}
                </a>
              </div>
            </li>
            <li>{t('connect.paste.step2')}</li>
            <li>{t('connect.paste.step3')}</li>
          </ol>
          <div className="field">
            <label htmlFor={pasteId} className="field-label">
              {t('connect.paste.label')}
            </label>
            <textarea
              id={pasteId}
              className="input mono"
              rows={3}
              value={launch}
              onChange={(e) => setLaunch(e.target.value)}
              placeholder="ltgopenlmsapp://token=…"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${pasteId}-err` : undefined}
            />
            {error && (
              <p id={`${pasteId}-err`} className="field-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <Button type="submit" variant="primary" busy={busy}>
            {t('connect.paste.submit')}
          </Button>
        </form>
      </Card>
    </div>
  );
}

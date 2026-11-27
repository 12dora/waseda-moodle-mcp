import { type FormEvent, useId, useState } from 'react';
import type { ConnectRequest } from '../api/types';
import { useT } from '../i18n';
import { pasteErrorKey, pasteRequest } from '../lib/connectInput';
import { errorText } from '../lib/errors';
import { useConfig } from '../session';
import { Button } from './Button';
import { Card } from './Card';

type Connect = (body: ConnectRequest) => Promise<void>;

/** Without a store listing: the package this service ships, loaded unpacked (developer mode). */
function ManualInstall() {
  const t = useT();
  return (
    <ol className="steps">
      <li>{t('connect.ext.manual1')}</li>
      <li>{t('connect.ext.manual2')}</li>
      <li>{t('connect.ext.manual3')}</li>
      <li>{t('connect.ext.manual4', { url: window.location.origin })}</li>
    </ol>
  );
}

/** The browser extension: the store listing when the instance has one, else the package from this service. */
function ExtensionCard({ url }: { url: string | null }) {
  const t = useT();
  return (
    <Card title={t('connect.ext.title')} actions={<span className="badge badge-ok">{t('connect.ext.badge')}</span>}>
      <div className="stack">
        <p className="muted">{t('connect.ext.desc')}</p>
        {url ? null : <ManualInstall />}
        <a className="btn btn-primary" href={url ?? '/extension.zip'} target="_blank" rel="noopener noreferrer">
          {t(url ? 'connect.ext.install' : 'connect.ext.download')}
        </a>
      </div>
    </Card>
  );
}

/** One field for the MoodleSession cookie; a Moodle app launch link is accepted too. */
function PasteCard({ onConnect }: { onConnect: Connect }) {
  const t = useT();
  const { moodleUrl, launchUrl } = useConfig();
  const inputId = useId();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const moodle = moodleUrl.replace(/\/+$/, '');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const request = pasteRequest(value, launchUrl);
    if (!request) {
      setError(t('connect.paste.required'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConnect(request);
    } catch (err) {
      const key = pasteErrorKey(err, request);
      setError(key ? t(key) : errorText(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('connect.paste.title')}>
      <form className="stack" onSubmit={submit} noValidate>
        <ol className="steps">
          <li>
            {t('connect.paste.step1')}
            <div>
              <a className="btn btn-secondary btn-sm" href={`${moodle}/my/`} target="_blank" rel="noopener noreferrer">
                {t('connect.paste.open')}
              </a>
            </div>
          </li>
          <li>{t('connect.paste.step2', { url: moodle })}</li>
          <li>{t('connect.paste.step3')}</li>
        </ol>
        <div className="field">
          <label htmlFor={inputId} className="field-label">
            {t('connect.paste.label')}
          </label>
          <input
            id={inputId}
            type="text"
            className="input mono"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="MoodleSession=…"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${inputId}-hint ${inputId}-err` : `${inputId}-hint`}
          />
          <p id={`${inputId}-hint`} className="muted small">
            {t('connect.paste.hint')}
          </p>
          {error && (
            <p id={`${inputId}-err`} className="field-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <Button type="submit" variant="primary" busy={busy}>
          {t('connect.paste.submit')}
        </Button>
      </form>
    </Card>
  );
}

/** The ways to connect Moodle: the browser extension (store listing or this service's package) or pasting. */
export function ConnectMethods({ onConnect }: { onConnect: Connect }) {
  const t = useT();
  const { extensionUrl } = useConfig();
  return (
    <div className="stack">
      <ExtensionCard url={extensionUrl} />
      <PasteCard onConnect={onConnect} />
      <p className="muted small">{t('connect.phoneHint')}</p>
    </div>
  );
}

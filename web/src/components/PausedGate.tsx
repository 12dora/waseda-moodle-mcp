import { type ReactNode, useEffect, useState } from 'react';
import { setPausedHandler } from '../api/client';
import { useT } from '../i18n';

/** Replaces the whole console with a notice once any API call hits the usage-guard edge block. */
export function PausedGate({ children }: { children: ReactNode }) {
  const t = useT();
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    setPausedHandler(() => setPaused(true));
    return () => setPausedHandler(null);
  }, []);

  useEffect(() => {
    if (paused) document.title = `${t('paused.title')} · Waseda Moodle MCP`;
  }, [paused, t]);

  if (!paused) return children;
  return (
    <main className="center-page paused" role="alert">
      <span className="brand">
        <span className="brand-mark" aria-hidden="true">
          W
        </span>
        {t('app.name')}
      </span>
      <h1 className="page-title">{t('paused.title')}</h1>
      <p className="muted">{t('paused.desc')}</p>
    </main>
  );
}

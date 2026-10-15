import { type ReactNode, useEffect, useState } from 'react';
import { type EdgeBlock, setPausedHandler } from '../api/client';
import { useT } from '../i18n';
import { Button } from './Button';

/**
 * Replaces the whole console with a notice once any API call is blocked at the edge: the usage guard
 * (paused until the window resets) or a Cloudflare challenge (generic, usually short-lived).
 */
export function PausedGate({ children }: { children: ReactNode }) {
  const t = useT();
  const [blocked, setBlocked] = useState<EdgeBlock | null>(null);

  useEffect(() => {
    setPausedHandler((kind) => setBlocked(kind));
    return () => setPausedHandler(null);
  }, []);

  const title = blocked === 'challenge' ? t('paused.unavailable') : t('paused.title');

  useEffect(() => {
    if (blocked) document.title = `${title} · Waseda Moodle MCP`;
  }, [blocked, title]);

  if (!blocked) return children;
  return (
    <main className="center-page paused" role="alert">
      <span className="brand">
        <span className="brand-mark" aria-hidden="true">
          W
        </span>
        {t('app.name')}
      </span>
      <h1 className="page-title">{title}</h1>
      <p className="muted">{blocked === 'challenge' ? t('paused.retrySoon') : t('paused.desc')}</p>
      <div>
        <Button onClick={() => location.reload()}>{t('common.reload')}</Button>
      </div>
    </main>
  );
}

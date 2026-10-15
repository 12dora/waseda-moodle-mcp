import { type ReactNode, useEffect } from 'react';
import { useT } from '../i18n';
import { SOURCE_URL } from '../lib/links';
import { LangSelect } from './LangSelect';

/** Signed-out frame for /connect and /oauth/consent. */
export function PublicShell({ title, children }: { title: string; children: ReactNode }) {
  const t = useT();
  useEffect(() => {
    document.title = `${title} · Waseda Moodle MCP`;
  }, [title]);
  return (
    <div className="public">
      <header className="public-head">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            W
          </span>
          {t('app.name')}
        </span>
        <LangSelect showLabel={false} />
      </header>
      <main id="main" className="public-main">
        {children}
      </main>
      <footer className="public-foot">
        <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
          {t('app.source')}
        </a>
      </footer>
    </div>
  );
}

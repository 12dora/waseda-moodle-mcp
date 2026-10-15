import { type ReactNode, useEffect } from 'react';
import { useI18n } from '../i18n';
import { landingPath } from '../lib/landing';
import { SOURCE_URL } from '../lib/links';
import type { Lang } from '../lib/time';

/** Same order, labels and `lang` attributes as the landing header. */
const LANG_LINKS: readonly { lang: Lang; label: string; htmlLang: string }[] = [
  { lang: 'ja', label: '日本語', htmlLang: 'ja' },
  { lang: 'en', label: 'EN', htmlLang: 'en' },
  { lang: 'zh-CN', label: '中文', htmlLang: 'zh-Hans' },
];

const GITHUB_PATH =
  'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z';

/**
 * Signed-out frame for /connect, /oauth/consent and /privacy, matching the landing pages.
 * Works without a router (/privacy renders outside it): plain anchors only.
 */
export function PublicShell({ title, children }: { title: string; children: ReactNode }) {
  const { lang, uiLang, setUiLang, t } = useI18n();
  useEffect(() => {
    document.title = `${title} · Waseda Moodle MCP`;
  }, [title]);
  return (
    <div className="public">
      <header className="public-head">
        <div className="public-wrap public-head-inner">
          <a className="public-mark" href={landingPath(lang)} aria-label={t('public.home')}>
            <i aria-hidden="true">W</i>
            {t('app.name')}
          </a>
          <div className="public-nav">
            <ul className="public-lang" aria-label={t('public.lang')}>
              {LANG_LINKS.map((l) => (
                <li key={l.lang}>
                  <button
                    type="button"
                    lang={l.htmlLang}
                    aria-pressed={lang === l.lang}
                    onClick={() => setUiLang(l.lang)}
                  >
                    {l.label}
                  </button>
                </li>
              ))}
            </ul>
            <a className="public-gh" href={SOURCE_URL} target="_blank" rel="noopener noreferrer" title="GitHub">
              <span className="sr-only">{t('app.source')}</span>
              <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" focusable="false">
                <path fill="currentColor" d={GITHUB_PATH} />
              </svg>
            </a>
          </div>
        </div>
      </header>
      <main id="main" className="public-main">
        {children}
      </main>
      <footer className="public-foot">
        <div className="public-wrap public-foot-inner">
          <p>© 2026 Waseda Moodle MCP · {t('public.unofficial')}</p>
          <p>
            <a href={uiLang === 'auto' ? '/privacy' : `/privacy?lang=${uiLang}`}>{t('public.privacy')}</a> ·{' '}
            <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
              {t('app.source')}
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}

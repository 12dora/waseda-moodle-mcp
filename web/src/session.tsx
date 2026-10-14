import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { Outlet } from 'react-router';
import { ApiError } from './api/client';
import { getMe } from './api/endpoints';
import type { AppConfig, Me, UserSettings } from './api/types';
import { ErrorBox } from './components/ErrorBox';
import { PageLoading } from './components/Spinner';
import { useI18n } from './i18n';

const ConfigContext = createContext<AppConfig | null>(null);

export function ConfigProvider({ config, children }: { config: AppConfig; children: ReactNode }) {
  return <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>;
}

export function useConfig(): AppConfig {
  const c = useContext(ConfigContext);
  if (!c) throw new Error('useConfig outside ConfigProvider');
  return c;
}

export interface Session {
  me: Me;
  setSettings: (settings: UserSettings) => void;
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside RequireSession');
  return s;
}

/** Layout route guard: loads /api/me (401 redirects to /connect via the API client). */
export function RequireSession({ children }: { children?: ReactNode }) {
  const { t, setUiLang } = useI18n();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<unknown>(null);

  const apply = useCallback(
    (next: Me) => {
      // An explicit account language wins over the local choice; 'auto' keeps the local one.
      const lang = next.user.settings.uiLang;
      if (lang !== 'auto') setUiLang(lang);
      setMe(next);
    },
    [setUiLang],
  );

  const load = useCallback(() => {
    setError(null);
    getMe().then(apply, (e: unknown) => {
      // 401 is handled by the API client (redirect to /connect)
      if (!(e instanceof ApiError && e.status === 401)) setError(e);
    });
  }, [apply]);

  useEffect(load, [load]);

  const setSettings = useCallback(
    (settings: UserSettings) => setMe((m) => (m ? { ...m, user: { ...m.user, settings } } : m)),
    [],
  );

  if (error) {
    return (
      <div className="center-page">
        <ErrorBox error={error} onRetry={load} />
      </div>
    );
  }
  if (!me) return <PageLoading label={t('common.loading')} />;

  return <SessionContext.Provider value={{ me, setSettings }}>{children ?? <Outlet />}</SessionContext.Provider>;
}

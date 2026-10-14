import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router';
import { setUnauthorizedHandler } from './api/client';
import { getConfig } from './api/endpoints';
import type { AppConfig } from './api/types';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ErrorBox } from './components/ErrorBox';
import { Layout } from './components/Layout';
import { PageLoading } from './components/Spinner';
import { ToastProvider } from './components/Toast';
import { I18nProvider, useT } from './i18n';
import { ActionsPage } from './pages/Actions';
import { ActivityPage } from './pages/Activity';
import { AppsPage } from './pages/Apps';
import { ConnectPage } from './pages/Connect';
import { DuePage } from './pages/Due';
import { KeysPage } from './pages/Keys';
import { OAuthConsentPage } from './pages/OAuthConsent';
import { OverviewPage } from './pages/Overview';
import { SettingsPage } from './pages/Settings';
import { ConfigProvider, RequireSession } from './session';

/** Lets the API client redirect to /connect without a full page reload. */
function UnauthorizedRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    setUnauthorizedHandler((returnTo) =>
      navigate(`/connect?return=${encodeURIComponent(returnTo)}`, { replace: true }),
    );
    return () => setUnauthorizedHandler(null);
  }, [navigate]);
  return null;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/connect" element={<ConnectPage />} />
      <Route path="/oauth/consent" element={<OAuthConsentPage />} />
      <Route element={<RequireSession />}>
        <Route element={<Layout />}>
          <Route index element={<OverviewPage />} />
          <Route path="due" element={<DuePage />} />
          <Route path="keys" element={<KeysPage />} />
          <Route path="apps" element={<AppsPage />} />
          <Route path="actions" element={<ActionsPage />} />
          <Route path="activity" element={<ActivityPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function Boot() {
  const t = useT();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = () => {
    setError(null);
    getConfig().then(setConfig, (e: unknown) => setError(e));
  };
  useEffect(load, []);

  if (error) {
    return (
      <div className="center-page">
        <ErrorBox error={error} onRetry={load} />
      </div>
    );
  }
  if (!config) return <PageLoading label={t('common.loading')} />;

  return (
    <ConfigProvider config={config}>
      <BrowserRouter>
        <UnauthorizedRedirect />
        <AppRoutes />
      </BrowserRouter>
    </ConfigProvider>
  );
}

export function App() {
  return (
    <I18nProvider>
      <ErrorBoundary>
        <ToastProvider>
          <Boot />
        </ToastProvider>
      </ErrorBoundary>
    </I18nProvider>
  );
}

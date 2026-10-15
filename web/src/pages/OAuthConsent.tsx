import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ApiError } from '../api/client';
import { approveOAuth, connect, denyOAuth, getMe, getOAuthRequest } from '../api/endpoints';
import type { ConnectRequest, OAuthRequestInfo, Scope } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ConnectMethods } from '../components/ConnectMethods';
import { ErrorBox } from '../components/ErrorBox';
import { PublicShell } from '../components/PublicShell';
import { PageLoading } from '../components/Spinner';
import { useT } from '../i18n';
import { errorText } from '../lib/errors';
import { isSafeRedirect, rememberReturn, takeReturn } from '../lib/returnTo';

type State =
  | { kind: 'loading' }
  | { kind: 'signin' }
  | { kind: 'invalid' }
  | { kind: 'error'; error: unknown }
  | { kind: 'ready'; info: OAuthRequestInfo }
  | { kind: 'redirecting' };

type Access = 'read' | 'write';

const isStatus = (e: unknown, ...codes: number[]) => e instanceof ApiError && codes.includes(e.status);

function failure(e: unknown): State {
  if (isStatus(e, 401)) return { kind: 'signin' };
  if (isStatus(e, 400, 404)) return { kind: 'invalid' };
  return { kind: 'error', error: e };
}

async function loadConsent(reqId: string): Promise<State> {
  if (!reqId) return { kind: 'invalid' };
  try {
    await getMe(false);
    return { kind: 'ready', info: await getOAuthRequest(reqId) };
  } catch (e) {
    return failure(e);
  }
}

function AccessOption({ access, checked, onSelect }: { access: Access; checked: boolean; onSelect?: () => void }) {
  const t = useT();
  const body = (
    <span>
      <strong>{t(access === 'write' ? 'common.readWrite' : 'common.readOnly')}</strong>
      <span className="muted">{t(access === 'write' ? 'consent.writeDesc' : 'consent.readDesc')}</span>
    </span>
  );
  if (!onSelect) return <div className="radio-card static">{body}</div>;
  return (
    <label className="radio-card">
      <input type="radio" name="access" checked={checked} onChange={onSelect} />
      {body}
    </label>
  );
}

function ConsentForm({ reqId, info, onRedirect }: { reqId: string; info: OAuthRequestInfo; onRedirect: () => void }) {
  const t = useT();
  const canWrite = info.scopes.includes('moodle:write');
  const [access, setAccess] = useState<Access>(canWrite ? 'write' : 'read');
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (allow: boolean) => {
    setBusy(allow ? 'allow' : 'deny');
    setError(null);
    try {
      const scopes: Scope[] = access === 'write' ? ['moodle:read', 'moodle:write'] : ['moodle:read'];
      const { redirectTo } = allow ? await approveOAuth(reqId, scopes) : await denyOAuth(reqId);
      if (!isSafeRedirect(redirectTo)) throw new Error(t('consent.unsafeRedirect'));
      onRedirect();
      location.href = redirectTo;
    } catch (e) {
      setBusy(null);
      // 403 = request started in another browser; the server explains it.
      setError(isStatus(e, 403) && e instanceof Error ? e.message : errorText(e, t));
    }
  };

  return (
    <Card>
      <div className="consent-app">
        <p className="consent-lead">{t('consent.lead', { app: info.clientName })}</p>
        {info.clientDomain && <p className="muted mono small">{info.clientDomain}</p>}
        {!info.verified && <span className="badge">{t('consent.unverified')}</span>}
      </div>
      <dl className={`kv${info.verified ? '' : ' kv-strong'}`}>
        <dt>{t('consent.redirect')}</dt>
        <dd className="mono">{info.redirectHost}</dd>
      </dl>
      <fieldset className="radio-group">
        <legend className="field-label">{t('consent.access')}</legend>
        {canWrite ? (
          <>
            <AccessOption access="write" checked={access === 'write'} onSelect={() => setAccess('write')} />
            <AccessOption access="read" checked={access === 'read'} onSelect={() => setAccess('read')} />
          </>
        ) : (
          <AccessOption access="read" checked />
        )}
      </fieldset>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <Button variant="primary" busy={busy === 'allow'} disabled={busy !== null} onClick={() => decide(true)}>
          {t('consent.allow')}
        </Button>
        <Button variant="secondary" busy={busy === 'deny'} disabled={busy !== null} onClick={() => decide(false)}>
          {t('consent.deny')}
        </Button>
      </div>
    </Card>
  );
}

interface BodyProps {
  state: State;
  reqId: string;
  reload: () => void;
  onRedirect: () => void;
}

function ConsentBody({ state, reqId, reload, onRedirect }: BodyProps) {
  const t = useT();
  switch (state.kind) {
    case 'loading':
      return <PageLoading label={t('common.loading')} />;
    case 'redirecting':
      return (
        <p className="muted" role="status">
          {t('consent.redirecting')}
        </p>
      );
    case 'invalid':
      return (
        <div className="alert alert-error" role="alert">
          {t('consent.invalid')}
        </div>
      );
    case 'error':
      return <ErrorBox error={state.error} onRetry={reload} />;
    case 'ready':
      return <ConsentForm reqId={reqId} info={state.info} onRedirect={onRedirect} />;
    case 'signin':
      return null;
  }
}

export function OAuthConsentPage() {
  const t = useT();
  const [params] = useSearchParams();
  const reqId = params.get('req') ?? '';
  const [state, setState] = useState<State>({ kind: 'loading' });

  const reload = useCallback(() => {
    setState({ kind: 'loading' });
    loadConsent(reqId).then((next) => {
      if (next.kind === 'signin') rememberReturn(location.pathname + location.search);
      setState(next);
    });
  }, [reqId]);

  useEffect(reload, [reload]);

  const onConnect = async (body: ConnectRequest) => {
    await connect(body);
    takeReturn(null); // consumed: we are already on the return page
    reload();
  };

  const title = t('consent.title');
  return (
    <PublicShell title={title}>
      <div className="narrow consent">
        <h1 className="page-title">{title}</h1>
        {state.kind === 'signin' && (
          <>
            <p className="page-desc">{t('consent.signin')}</p>
            <ConnectMethods onConnect={onConnect} />
          </>
        )}
        <ConsentBody state={state} reqId={reqId} reload={reload} onRedirect={() => setState({ kind: 'redirecting' })} />
      </div>
    </PublicShell>
  );
}

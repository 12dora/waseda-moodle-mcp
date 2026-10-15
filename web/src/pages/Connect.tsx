import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ApiError } from '../api/client';
import { connect, getMe } from '../api/endpoints';
import type { ConnectRequest, Me } from '../api/types';
import { AccountSwitchCard } from '../components/AccountSwitchCard';
import { ConnectMethods } from '../components/ConnectMethods';
import { ErrorBox } from '../components/ErrorBox';
import { PublicShell } from '../components/PublicShell';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { useT } from '../i18n';
import { rememberReturn, takeReturn } from '../lib/returnTo';

/** Removes `code` (single-use handoff, §11) from the address bar and history. */
function stripCode(): void {
  const url = new URL(location.href);
  url.searchParams.delete('code');
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
}

/** Name of the account a handoff code belongs to, when the server asks to confirm an account switch. */
function switchTarget(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.status !== 409 || e.code !== 'account_switch') return null;
  const name = (e.body as { account?: { fullname?: unknown } } | null)?.account?.fullname;
  return typeof name === 'string' ? name : '';
}

interface PendingSwitch {
  code: string;
  name: string;
}

export function ConnectPage() {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const returnParam = params.get('return');
  const [me, setMe] = useState<Me | null>(null);
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeError, setCodeError] = useState<unknown>(null);
  const [pendingSwitch, setPendingSwitch] = useState<PendingSwitch | null>(null);
  const handled = useRef(false);

  const doConnect = useCallback(
    async (body: ConnectRequest) => {
      await connect(body);
      toast.show(t('connect.connected'));
      navigate(takeReturn(returnParam), { replace: true });
    },
    [navigate, returnParam, t, toast],
  );

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    rememberReturn(returnParam);
    const code = new URLSearchParams(location.search).get('code');
    if (!code) {
      getMe(false).then(setMe, () => setMe(null));
      return;
    }
    stripCode();
    setCodeBusy(true);
    doConnect({ code }).catch((e: unknown) => {
      setCodeBusy(false);
      const name = switchTarget(e);
      if (name === null) setCodeError(e);
      else setPendingSwitch({ code, name });
    });
  }, [doConnect, returnParam]);

  if (codeBusy) {
    return (
      <PublicShell title={t('connect.title')}>
        <div className="center-block" role="status">
          <Spinner size={28} />
          <p>{t('connect.connecting')}</p>
        </div>
      </PublicShell>
    );
  }

  if (pendingSwitch) {
    return (
      <PublicShell title={t('connect.switch.title')}>
        <div className="narrow">
          <AccountSwitchCard
            name={pendingSwitch.name}
            onSwitch={() => doConnect({ code: pendingSwitch.code, switchAccount: true })}
            onCancel={() => {
              takeReturn(null);
              navigate('/', { replace: true });
            }}
          />
        </div>
      </PublicShell>
    );
  }

  const title = me ? t('connect.reconnectTitle') : t('connect.title');
  return (
    <PublicShell title={title}>
      <div className="narrow">
        <h1 className="page-title">{title}</h1>
        <p className="page-desc">{t('connect.lead')}</p>
        {me && (
          <p className="signed-in">
            {t('connect.signedInAs', { name: me.user.fullname })} · <Link to="/">{t('connect.openConsole')}</Link>
          </p>
        )}
        {codeError != null && <ErrorBox error={codeError} />}
        <ConnectMethods onConnect={doConnect} />
        <p className="fine-print">{t('connect.privacy')}</p>
      </div>
    </PublicShell>
  );
}

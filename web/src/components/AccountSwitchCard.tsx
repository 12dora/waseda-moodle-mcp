import { useEffect, useState } from 'react';
import { getMe } from '../api/endpoints';
import { useT } from '../i18n';
import { errorText } from '../lib/errors';
import { Button } from './Button';
import { Card } from './Card';

/** Confirms signing in as a different Moodle user than the one already signed in (login-CSRF guard). */
export function AccountSwitchCard({
  name,
  onSwitch,
  onCancel,
}: {
  name: string;
  onSwitch: () => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMe(false).then(
      (me) => setCurrent(me.user.fullname),
      () => setCurrent(null),
    );
  }, []);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSwitch();
    } catch (e) {
      setBusy(false);
      setError(errorText(e, t));
    }
  };

  return (
    <Card title={t('connect.switch.title')}>
      <p>{current ? t('connect.switch.desc', { current, name }) : t('connect.switch.descUnknown', { name })}</p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <Button variant="primary" busy={busy} onClick={confirm}>
          {t('connect.switch.confirm')}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </Card>
  );
}

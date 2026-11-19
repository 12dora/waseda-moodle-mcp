import { type ReactNode, useState } from 'react';
import { useT } from '../i18n';
import { errorText } from '../lib/errors';
import { Button } from './Button';
import { Dialog } from './Dialog';

/**
 * Confirmation with a destructive (or, with `variant`, a primary) action; keeps the dialog open and shows the error
 * on failure.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  variant = 'danger',
  children,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  variant?: 'danger' | 'primary';
  children?: ReactNode;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const close = () => {
    if (busy) return;
    setError(null);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={variant}
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
                setBusy(false);
                onClose();
              } catch (e) {
                setBusy(false);
                setError(e);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {description && <p className="muted">{description}</p>}
      {children}
      {error != null && (
        <p className="field-error" role="alert">
          {errorText(error, t)}
        </p>
      )}
    </Dialog>
  );
}

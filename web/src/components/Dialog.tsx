import { type ReactNode, useEffect, useId, useRef } from 'react';

/**
 * Native <dialog> (focus trap and inert background come from the browser). Esc closes it unless
 * `dismissible` is false, in which case only an explicit button in `footer` can close it.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  // Opens modally while `open`; on close or unmount, closes first and hands focus back to the opener.
  useEffect(() => {
    const el = ref.current;
    if (!el || !open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!el.open) el.showModal();
    return () => {
      if (el.open) el.close();
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
    >
      {open && (
        <div className="dialog-body">
          <h2 className="dialog-title" id={titleId}>
            {title}
          </h2>
          {children}
          {footer && <div className="dialog-footer">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

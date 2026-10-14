import { useId, useRef, useState } from 'react';
import { useT } from '../i18n';
import { copyText } from '../lib/clipboard';
import { Button } from './Button';
import { useToast } from './Toast';

/** Read-only value with a copy button. `multiline` renders a <pre>-like textarea for commands. */
export function CopyField({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
  const t = useT();
  const toast = useToast();
  const id = useId();
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    const ok = await copyText(value, ref.current);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      ref.current?.select();
      toast.show(t('common.copyFailed'), 'error');
    }
  };

  return (
    <div className="field">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <div className="copy-field">
        {multiline ? (
          <textarea
            id={id}
            ref={ref}
            readOnly
            value={value}
            rows={3}
            className="input mono"
            spellCheck={false}
            onFocus={(e) => e.currentTarget.select()}
          />
        ) : (
          <input
            id={id}
            ref={ref}
            readOnly
            value={value}
            className="input mono"
            spellCheck={false}
            onFocus={(e) => e.currentTarget.select()}
          />
        )}
        <Button onClick={onCopy} aria-live="polite">
          {copied ? t('common.copied') : t('common.copy')}
        </Button>
      </div>
    </div>
  );
}

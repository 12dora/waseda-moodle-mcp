import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';

type Tone = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  tone: Tone;
  text: string;
}

interface ToastApi {
  show: (text: string, tone?: Tone) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const t = useT();

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);

  const show = useCallback(
    (text: string, tone: Tone = 'success') => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-2), { id, tone, text }]);
      setTimeout(() => dismiss(id), tone === 'error' ? 7000 : 4000);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {items.map((x) => (
          <div key={x.id} className={`toast toast-${x.tone}`} role={x.tone === 'error' ? 'alert' : 'status'}>
            <span>{x.text}</span>
            <button type="button" className="toast-close" aria-label={t('common.close')} onClick={() => dismiss(x.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx;
}

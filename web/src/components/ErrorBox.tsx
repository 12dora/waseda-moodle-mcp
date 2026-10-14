import { useT } from '../i18n';
import { errorText } from '../lib/errors';
import { Button } from './Button';

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useT();
  return (
    <div className="alert alert-error" role="alert">
      <span>{errorText(error, t)}</span>
      {onRetry && (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  );
}

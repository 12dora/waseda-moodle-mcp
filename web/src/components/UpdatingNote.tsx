import { useT } from '../i18n';

/** Shown while a stored answer is refreshed in the background (useCachedQuery `refreshing`): muted, no spinner. */
export function UpdatingNote({ show }: { show: boolean }) {
  const t = useT();
  return show ? <p className="muted small">{t('common.updating')}</p> : null;
}

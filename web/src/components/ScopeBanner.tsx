import { Link } from 'react-router';
import { useT } from '../i18n';
import { useSession } from '../session';

/** Shown while the user has not confirmed their courses (scope = automatic suggestion). */
export function ScopeBanner() {
  const t = useT();
  const { me } = useSession();
  if (me.user.settings.myCourseIds !== null) return null;
  return (
    <div className="alert alert-info">
      <span>{t('scope.banner')}</span>
      <Link to="/settings/courses">{t('scope.confirm')}</Link>
    </div>
  );
}

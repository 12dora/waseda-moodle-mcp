import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { logout } from '../api/endpoints';
import { type MessageKey, useT } from '../i18n';
import { errorText } from '../lib/errors';
import { useSession } from '../session';
import { Button } from './Button';
import { useToast } from './Toast';

const NAV: ReadonlyArray<{ to: string; key: MessageKey; end?: boolean }> = [
  { to: '/', key: 'nav.overview', end: true },
  { to: '/due', key: 'nav.due' },
  { to: '/courses', key: 'nav.courses' },
  { to: '/timetable', key: 'nav.timetable' },
  { to: '/actions', key: 'nav.actions' },
  { to: '/keys', key: 'nav.keys' },
  { to: '/apps', key: 'nav.apps' },
  { to: '/activity', key: 'nav.activity' },
  { to: '/settings', key: 'nav.settings' },
];

/** Mobile menu: focus moves into the menu on open; Esc or a click outside closes it. */
function useMobileMenu(menuRef: RefObject<HTMLElement | null>, buttonRef: RefObject<HTMLButtonElement | null>) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('a, button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open, menuRef, buttonRef]);

  return { open, setOpen };
}

export function Layout() {
  const t = useT();
  const toast = useToast();
  const { me } = useSession();
  const navigate = useNavigate();
  const menuRef = useRef<HTMLElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menu = useMobileMenu(menuRef, buttonRef);
  const [signingOut, setSigningOut] = useState(false);

  const onSignOut = async () => {
    setSigningOut(true);
    try {
      await logout();
      navigate('/connect', { replace: true });
    } catch (e) {
      setSigningOut(false);
      toast.show(errorText(e, t), 'error');
    }
  };

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        {t('nav.skip')}
      </a>
      <header className="topbar">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            W
          </span>
          {t('app.name')}
        </span>
        <button
          type="button"
          className="menu-btn"
          ref={buttonRef}
          aria-expanded={menu.open}
          aria-controls="sidenav"
          onClick={() => menu.setOpen((v) => !v)}
        >
          <span className="menu-icon" aria-hidden="true" />
          <span className="sr-only">{t('nav.menu')}</span>
        </button>
      </header>
      <aside id="sidenav" ref={menuRef} className={`sidenav${menu.open ? ' open' : ''}`}>
        <div className="brand sidenav-brand">
          <span className="brand-mark" aria-hidden="true">
            W
          </span>
          {t('app.name')}
        </div>
        <nav aria-label={t('nav.label')}>
          <ul className="nav-list">
            {NAV.map((n) => (
              <li key={n.to}>
                <NavLink
                  to={n.to}
                  end={n.end}
                  className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
                  onClick={() => menu.setOpen(false)}
                >
                  {t(n.key)}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="sidenav-foot">
          <div className="user-name" title={me.user.fullname}>
            {me.user.fullname}
          </div>
          <Button variant="ghost" size="sm" busy={signingOut} onClick={onSignOut}>
            {t('nav.signOut')}
          </Button>
        </div>
      </aside>
      <main id="main" className="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}

export function PageHeader({ title, desc, actions }: { title: string; desc?: string; actions?: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · Waseda Moodle MCP`;
  }, [title]);
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        {desc && <p className="page-desc">{desc}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { listActions, logout } from '../api/endpoints';
import { type MessageKey, useT } from '../i18n';
import { errorText } from '../lib/errors';
import { SOURCE_URL } from '../lib/links';
import { PENDING_LIMIT, pendingCountText } from '../lib/pending';
import { useSession } from '../session';
import { Button } from './Button';
import { useToast } from './Toast';

const NAV: ReadonlyArray<{ to: string; key: MessageKey; end?: boolean }> = [
  { to: '/', key: 'nav.overview', end: true },
  { to: '/due', key: 'nav.due' },
  { to: '/courses', key: 'nav.courses' },
  { to: '/timetable', key: 'nav.timetable' },
  { to: '/actions', key: 'nav.actions' },
  { to: '/settings', key: 'nav.settings' },
];

/** Fired after an approval is approved or cancelled so the sidebar badge refreshes at once. */
const ACTIONS_CHANGED = 'wmm:actions-changed';
const BADGE_REFRESH_MS = 30_000;

export function notifyActionsChanged() {
  window.dispatchEvent(new Event(ACTIONS_CHANGED));
}

/** Pending approvals count: on mount and route change (at most every 30 s), at once on ACTIONS_CHANGED. */
function usePendingCount(): number {
  const { pathname } = useLocation();
  const [count, setCount] = useState(0);
  const lastFetch = useRef(0);
  const seq = useRef(0);

  const refresh = useCallback((force: boolean) => {
    const now = Date.now();
    if (!force && now - lastFetch.current < BADGE_REFRESH_MS) return;
    lastFetch.current = now;
    const mine = ++seq.current;
    listActions('pending', PENDING_LIMIT).then(
      (list) => {
        if (mine === seq.current) setCount(list.length);
      },
      () => {
        // The badge is a hint only; errors surface on the Approvals page.
      },
    );
  }, []);

  useEffect(() => {
    // Opening Approvals always re-syncs the badge with the list shown there.
    refresh(pathname === '/actions');
  }, [pathname, refresh]);

  useEffect(() => {
    const onChanged = () => refresh(true);
    window.addEventListener(ACTIONS_CHANGED, onChanged);
    return () => window.removeEventListener(ACTIONS_CHANGED, onChanged);
  }, [refresh]);

  return count;
}

function PendingBadge({ count }: { count: number }) {
  const t = useT();
  if (count === 0) return null;
  const text = pendingCountText(count);
  return (
    <>
      <span className="nav-badge" aria-hidden="true">
        {text}
      </span>
      <span className="sr-only">{t('nav.approvalsBadge', { count: text })}</span>
    </>
  );
}

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
  const pending = usePendingCount();

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
                  <span>{t(n.key)}</span>
                  {n.to === '/actions' && <PendingBadge count={pending} />}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <a className="source-link" href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
          {t('app.source')}
        </a>
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

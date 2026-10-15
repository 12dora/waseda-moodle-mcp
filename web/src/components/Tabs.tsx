import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useRef } from 'react';

interface TabItem<T extends string> {
  id: T;
  label: string;
}

const tabId = (prefix: string, id: string) => `${prefix}-tab-${id}`;
const panelId = (prefix: string, id: string) => `${prefix}-panel-${id}`;

/** Arrow / Home / End move between tabs (WAI-ARIA tabs pattern, automatic activation). */
const KEY_MOVES: Record<string, (i: number, n: number) => number> = {
  ArrowRight: (i, n) => (i + 1) % n,
  ArrowLeft: (i, n) => (i - 1 + n) % n,
  Home: () => 0,
  End: (_i, n) => n - 1,
};

/** Keeps the active tab visible inside a horizontally scrolling tablist (phones). */
function useActiveTabVisible(listRef: RefObject<HTMLDivElement | null>, activeId: string) {
  useEffect(() => {
    const list = listRef.current;
    const tab = document.getElementById(activeId);
    if (!list || !tab) return;
    const box = list.getBoundingClientRect();
    const r = tab.getBoundingClientRect();
    if (r.left < box.left) list.scrollLeft -= box.left - r.left;
    else if (r.right > box.right) list.scrollLeft += r.right - box.right;
  }, [listRef, activeId]);
}

/** How the tab was chosen: router-driven tabs replace history for keyboard moves and push for clicks. */
interface TabChange {
  via: 'keyboard' | 'pointer';
}

interface TabsProps<T extends string> {
  /** Prefix for the tab / panel element ids; pair each tab with a `TabPanel` using the same prefix. */
  idPrefix: string;
  label: string;
  items: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (id: T, change: TabChange) => void;
}

/** Controlled accessible tablist: works with local state or with the router. */
export function Tabs<T extends string>({ idPrefix, label, items, value, onChange }: TabsProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  useActiveTabVisible(listRef, tabId(idPrefix, value));

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const move = KEY_MOVES[e.key];
    if (!move) return;
    e.preventDefault();
    const current = items.findIndex((it) => it.id === value);
    const next = items[move(current, items.length)];
    if (!next) return;
    onChange(next.id, { via: 'keyboard' });
    document.getElementById(tabId(idPrefix, next.id))?.focus();
  };

  return (
    <div className="tabs" role="tablist" aria-label={label} ref={listRef}>
      {items.map((it) => {
        const active = it.id === value;
        return (
          <button
            key={it.id}
            type="button"
            role="tab"
            id={tabId(idPrefix, it.id)}
            aria-selected={active}
            aria-controls={panelId(idPrefix, it.id)}
            tabIndex={active ? 0 : -1}
            className={`tab${active ? ' active' : ''}`}
            onClick={() => {
              if (!active) onChange(it.id, { via: 'pointer' });
            }}
            onKeyDown={onKeyDown}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

interface TabPanelProps {
  idPrefix: string;
  id: string;
  active: boolean;
  className?: string;
  children: ReactNode;
}

/** Panel for one tab; inactive panels stay in the DOM (hidden) so `aria-controls` always resolves. */
export function TabPanel({ idPrefix, id, active, className, children }: TabPanelProps) {
  return (
    <div
      role="tabpanel"
      id={panelId(idPrefix, id)}
      aria-labelledby={tabId(idPrefix, id)}
      hidden={!active}
      className={`tab-panel${className ? ` ${className}` : ''}`}
    >
      {children}
    </div>
  );
}

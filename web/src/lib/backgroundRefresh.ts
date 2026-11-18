/** Minimal event surface of `document` / `window`, so the watcher can be tested without a DOM. */
export interface RefreshEvents {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface RefreshOptions {
  /** Called for each background refresh. */
  reload: () => void;
  /** Whether the periodic poll should reload right now (e.g. something is pending). */
  shouldPoll: () => boolean;
  doc: RefreshEvents & { visibilityState: string };
  win: RefreshEvents;
  /** Events fired together (visibilitychange + focus) collapse into one reload within this window. */
  debounceMs?: number;
  pollMs?: number;
}

export const REFRESH_DEBOUNCE_MS = 300;
export const REFRESH_POLL_MS = 30_000;

/**
 * Reloads when the tab becomes visible or the window gains focus (debounced), and polls while visible.
 * Returns a stop function that removes every listener and timer.
 */
export function startBackgroundRefresh(opts: RefreshOptions): () => void {
  const { reload, shouldPoll, doc, win } = opts;
  const visible = () => doc.visibilityState === 'visible';
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    if (debounce !== undefined) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      if (visible()) reload();
    }, opts.debounceMs ?? REFRESH_DEBOUNCE_MS);
  };
  const onVisibility = () => {
    if (visible()) schedule();
  };
  const poll = setInterval(() => {
    if (visible() && shouldPoll()) reload();
  }, opts.pollMs ?? REFRESH_POLL_MS);

  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('focus', schedule);
  return () => {
    if (debounce !== undefined) clearTimeout(debounce);
    clearInterval(poll);
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('focus', schedule);
  };
}

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { REFRESH_DEBOUNCE_MS, REFRESH_POLL_MS, type RefreshEvents, startBackgroundRefresh } from './backgroundRefresh';

class FakeEvents implements RefreshEvents {
  private readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string) {
    for (const l of this.listeners.get(type) ?? []) l();
  }
  count(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

class FakeDoc extends FakeEvents {
  visibilityState = 'visible';
}

describe('startBackgroundRefresh', () => {
  let doc: FakeDoc;
  let win: FakeEvents;
  let reload: Mock<() => void>;
  let pending: boolean;
  let stop: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    doc = new FakeDoc();
    win = new FakeEvents();
    reload = vi.fn<() => void>();
    pending = true;
    stop = startBackgroundRefresh({ reload, shouldPoll: () => pending, doc, win });
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it('reloads once when visibilitychange and focus fire together', () => {
    doc.emit('visibilitychange');
    win.emit('focus');
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('ignores visibilitychange to hidden', () => {
    doc.visibilityState = 'hidden';
    doc.emit('visibilitychange');
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(reload).not.toHaveBeenCalled();
  });

  it('polls while visible and something is pending', () => {
    vi.advanceTimersByTime(REFRESH_POLL_MS);
    expect(reload).toHaveBeenCalledTimes(1);
    pending = false;
    vi.advanceTimersByTime(REFRESH_POLL_MS);
    expect(reload).toHaveBeenCalledTimes(1);
    pending = true;
    doc.visibilityState = 'hidden';
    vi.advanceTimersByTime(REFRESH_POLL_MS);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('removes listeners and timers on stop', () => {
    stop();
    expect(doc.count() + win.count()).toBe(0);
    doc.emit('visibilitychange');
    win.emit('focus');
    vi.advanceTimersByTime(REFRESH_POLL_MS * 2);
    expect(reload).not.toHaveBeenCalled();
  });
});

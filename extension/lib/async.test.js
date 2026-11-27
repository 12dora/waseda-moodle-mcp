import { afterEach, describe, expect, it, vi } from 'vitest';
import { debounce, singleFlight } from './async.js';

/** A task whose runs finish only when the test says so. */
function controlled() {
  const finishers = [];
  const task = vi.fn(() => new Promise((resolve) => finishers.push(resolve)));
  return { task, finish: (value) => finishers.shift()(value) };
}

describe('debounce', () => {
  afterEach(() => vi.useRealTimers());

  it('runs once after the last call', () => {
    vi.useFakeTimers();
    const task = vi.fn();
    const d = debounce(task, 5000);
    d.schedule();
    vi.advanceTimersByTime(4000);
    d.schedule();
    vi.advanceTimersByTime(4000);
    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('can be cancelled', () => {
    vi.useFakeTimers();
    const task = vi.fn();
    const d = debounce(task, 5000);
    d.schedule();
    d.cancel();
    vi.advanceTimersByTime(10000);
    expect(task).not.toHaveBeenCalled();
  });
});

describe('singleFlight', () => {
  it('shares the current run and starts again afterwards', async () => {
    const { task, finish } = controlled();
    const flight = singleFlight(task);
    const first = flight.run();
    expect(flight.run()).toBe(first);
    finish('a');
    await expect(first).resolves.toBe('a');
    const second = flight.run();
    finish('b');
    await expect(second).resolves.toBe('b');
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('runFresh waits for the current run, then runs again', async () => {
    const { task, finish } = controlled();
    const flight = singleFlight(task);
    const first = flight.run();
    const fresh = flight.runFresh();
    expect(task).toHaveBeenCalledTimes(1);
    finish('old');
    await first;
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(2));
    finish('new');
    await expect(fresh).resolves.toBe('new');
  });

  it('runFresh still runs when the current run fails', async () => {
    const task = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue('ok');
    const flight = singleFlight(task);
    const first = flight.run();
    const fresh = flight.runFresh();
    await expect(first).rejects.toThrow('boom');
    await expect(fresh).resolves.toBe('ok');
  });
});

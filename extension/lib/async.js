// Timing helpers of the background worker. Pure; no chrome.* access here.

/** Runs `task` once, `ms` after the last `schedule()`. */
export function debounce(task, ms) {
  let timer;
  return {
    schedule() {
      clearTimeout(timer);
      timer = setTimeout(task, ms);
    },
    cancel() {
      clearTimeout(timer);
    },
  };
}

/** One run of `task` at a time. */
export function singleFlight(task) {
  let running = null;
  /** Overlapping callers share the current run. */
  const run = () => {
    running ??= task().finally(() => {
      running = null;
    });
    return running;
  };
  /** A run that starts after this call, for callers whose news the current run may have missed. */
  const runFresh = () => (running ? running.catch(() => {}).then(run) : run());
  return { run, runFresh };
}

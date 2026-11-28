/**
 * Our own access log for Workers Logs (the automatic invocation logs are off: they may carry request headers such as
 * Authorization). One structured line per request: method, path without query or ticket, status, duration.
 */

/** Signed tickets (/f/<ticket>, /u/<ticket>) and every query string stay out of the log. */
export function logPath(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return '?';
  }
  const ticket = /^\/(f|u)\/./.exec(path);
  return ticket ? `/${ticket[1]}/…` : path;
}

export function logRequest(request: Request, status: number, ms: number): void {
  // biome-ignore lint/suspicious/noConsole: the access log is the point of this function
  console.log({ kind: 'request', method: request.method, path: logPath(request.url), status, ms });
}

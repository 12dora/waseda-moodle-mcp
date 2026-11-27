/**
 * MoodleApi on the web session (channel 'web'): ajax-enabled functions go to /lib/ajax/service.php as they are,
 * others are emulated by adapters (functions.ts); files through /pluginfile.php with the cookie, uploads through
 * the upload repository. Same call budget and read memo as MoodleClient (CallLedger).
 */

import type { InvocationBudget } from '../../budget';
import type { CallHint, DraftUploadResult, MoodleApi, MoodleChannel } from '../../context';
import { InvalidInput, MoodleBusy, MoodleError, MoodleUnavailable } from '../../errors';
import { CallLedger, isWriteCall, memoKey } from '../client';
import { randomDraftItemId, sessionFileUrl, type UploadFile } from '../wire';
import { AJAX_FUNCTIONS } from './ajax-functions';
import { WEB_FUNCTIONS } from './functions';
import { MoodleWebSession, type MoodleWebSessionOptions } from './session';
import type { WebSession } from './types';
import { uploadViaRepository } from './upload';

export interface WebMoodleClientOptions {
  session: Omit<MoodleWebSessionOptions, 'charge' | 'moodleUserId' | 'onTimeout'>;
  moodleUserId: number;
  maxCalls?: number; // default 40
  /** The invocation's shared allowance: every request is charged to it as well. */
  budget?: InvocationBudget;
  onSuccess?: () => void;
  /** The session's busy mark as stored (epoch ms, see MoodleBusy): until then every request fails fast. */
  busyUntil?: number | null;
  /** A request ran out of time: the session is busy until `until` (store the mark). Best effort. */
  onBusy?: (until: number) => void;
}

/**
 * How long a session counts as busy after one of its requests ran out of time. Moodle serialises the requests of one
 * session and keeps running a request we gave up on; whatever is sent meanwhile only queues behind it (measured
 * 2026-11-27: a backlog like that kept every request of the session timing out for over 10 minutes).
 */
const SESSION_BUSY_MS = 120_000;

type FileInit = { method?: 'GET' | 'HEAD'; range?: string };

const UNSUPPORTED = 'This needs the Moodle app service, which Waseda Moodle has turned off.';
const REDIRECT_MSG = 'Moodle redirected the download unexpectedly.';
const MAX_HOPS = 3;

const discard = (res: Response) => {
  res.body?.cancel().catch(() => {});
};

/** Moodle answers a missing file with 404, or with an error page (HTML without a file disposition) and 200. */
function isErrorPage(res: Response): boolean {
  const html = /text\/html/i.test(res.headers.get('content-type') ?? '');
  return res.ok && html && !res.headers.has('content-disposition');
}

export class WebMoodleClient implements MoodleApi {
  readonly channel: MoodleChannel = 'web';
  readonly moodleUserId: number;
  private readonly session: MoodleWebSession;

  get web(): WebSession {
    return this.session;
  }
  private readonly ledger: CallLedger;
  private readonly onSuccess?: () => void;
  private readonly onBusy?: (until: number) => void;
  private succeeded = false;
  private busyUntil: number;

  constructor(opts: WebMoodleClientOptions) {
    this.moodleUserId = opts.moodleUserId;
    this.onSuccess = opts.onSuccess;
    this.onBusy = opts.onBusy;
    this.busyUntil = opts.busyUntil ?? 0;
    this.ledger = new CallLedger({
      maxCalls: opts.maxCalls,
      budget: opts.budget,
      onClear: () => this.session.forgetPages(),
    });
    this.session = new MoodleWebSession({
      ...opts.session,
      moodleUserId: opts.moodleUserId,
      charge: () => {
        this.checkBusy();
        this.ledger.spend();
      },
      onTimeout: () => this.noteTimeout(),
    });
  }

  /** Before every request: while the session is busy it fails fast (MoodleBusy), without a request or a charge. */
  private checkBusy(): void {
    if (this.busyUntil > Date.now()) throw new MoodleBusy(this.busyUntil);
  }

  /** A request ran out of time: the session is busy for a while, for this client and (onBusy) for later ones. */
  private noteTimeout(): void {
    this.busyUntil = Date.now() + SESSION_BUSY_MS;
    try {
      this.onBusy?.(this.busyUntil);
    } catch {
      /* best effort */
    }
  }

  get baseUrl(): string {
    return this.session.baseUrl;
  }

  get callsMade(): number {
    return this.ledger.calls;
  }

  /** Write calls plus the session's form POSTs, uploads and ajax writes (MoodleApi.writesSent). */
  get writesSent(): number {
    return this.ledger.writes + this.session.writesSent;
  }

  call<T = unknown>(fn: string, params: Record<string, unknown> = {}, hint?: CallHint): Promise<T> {
    if (fn === 'core_files_get_unused_draft_itemid') {
      return Promise.resolve<unknown>({ itemid: randomDraftItemId(), warnings: [] }) as Promise<T>;
    }
    const exec = () => this.exec<T>(fn, params, hint ?? {});
    return this.ledger.run(memoKey(fn, params, hint), exec, isWriteCall(fn, params));
  }

  /** Dispatches synchronously (ajax calls of one tick must reach the session's queue together). */
  private async exec<T>(fn: string, params: Record<string, unknown>, hint: CallHint): Promise<T> {
    const out = await this.dispatch(fn, params, hint);
    this.markOk();
    return out as T;
  }

  private dispatch(fn: string, params: Record<string, unknown>, hint: CallHint): Promise<unknown> {
    if (AJAX_FUNCTIONS.has(fn)) return this.session.ajax(fn, params);
    const adapter = Object.hasOwn(WEB_FUNCTIONS, fn) ? WEB_FUNCTIONS[fn] : undefined;
    if (adapter) return adapter(this.session, params, hint);
    return Promise.reject(new MoodleError(UNSUPPORTED, 'servicenotavailable'));
  }

  private markOk(): void {
    if (this.succeeded) return;
    this.succeeded = true;
    try {
      this.onSuccess?.();
    } catch {
      /* best effort */
    }
  }

  // ------------------------------------------------------------------ files

  async fetchFile(fileUrl: string, init: FileInit = {}): Promise<Response> {
    const headers: Record<string, string> = init.range ? { Range: init.range } : {};
    let target = sessionFileUrl(this.baseUrl, fileUrl);
    for (let hop = 0; ; hop++) {
      const res = await this.session.send(target, { method: init.method ?? 'GET', headers });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) return this.checkFile(res);
      discard(res);
      this.session.checkLocation(location);
      this.session.acceptCookie(res);
      const next = this.nextHop(location, target, hop);
      if (!next) return this.notAFile();
      target = next;
    }
  }

  /**
   * Every hop is checked as the first URL was (sessionFileUrl). A same-origin page that is not a file (a folder whose
   * ZIP download is off sends the user to its view page) is not followed: that would spend a call and view the page.
   */
  private nextHop(location: string, from: string, hop: number): string | null {
    const next = URL.canParse(location, from) ? new URL(location, from) : null;
    if (hop >= MAX_HOPS || !next || next.origin !== new URL(this.baseUrl).origin) {
      throw new MoodleUnavailable(REDIRECT_MSG);
    }
    try {
      return sessionFileUrl(this.baseUrl, next.toString());
    } catch (e) {
      if (e instanceof InvalidInput) return null;
      throw e;
    }
  }

  /** Moodle answered, but with something other than the file: a 404 as for a missing file. */
  private notAFile(): Response {
    this.markOk();
    return new Response(null, { status: 404, statusText: 'Not Found' });
  }

  /**
   * As MoodleClient: the file, or Moodle's 403 / 404 answer for the caller to handle; an error page instead of the
   * file reads as a 404 (Moodle shows one for a missing file), the login page as the end of the session.
   */
  private async checkFile(res: Response): Promise<Response> {
    if (isErrorPage(res)) {
      this.session.checkSignedIn(await res.text().catch(() => ''));
      return this.notAFile();
    }
    if (res.ok) this.session.acceptCookie(res);
    this.markOk();
    return res;
  }

  async uploadToDraft(file: UploadFile, itemId: number, hint?: CallHint): Promise<DraftUploadResult> {
    if (!hint?.cmid) throw new InvalidInput('The activity for this upload is unknown.');
    const result = await uploadViaRepository(this.session, file, { itemId, cmid: hint.cmid });
    this.markOk();
    return result;
  }
}

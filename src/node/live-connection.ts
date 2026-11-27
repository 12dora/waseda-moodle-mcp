/**
 * The sign-in of a running local server: the options of each invocation's Moodle client, written back as Moodle
 * rotates the session, plus two timers (session keepalive, app service check).
 */

import { clearInterval, setInterval } from 'node:timers';
import { NeedsReconnect } from '../core/errors';
import { RECONNECT_STDIO } from '../core/mcp/wording';
import type { MoodleClientOptions } from '../core/moodle/client';
import type { ChannelClientOptions } from '../core/moodle/web/channel';
import type { WebMoodleClientOptions } from '../core/moodle/web/client';
import { identifySession } from '../core/moodle/web/identify';
import { mobileServiceEnabled } from '../core/moodle/web/public-config';
import { MoodleWebSession } from '../core/moodle/web/session';
import { type Credential, type LoadedCredential, replaceSession } from './credential-file';
import { type Identity, identifyToken } from './identify';

/** Moodle ends a session after 4 h without a request. */
const KEEPALIVE_MS = 3_600_000;
const SERVICE_CHECK_MS = 6 * 3_600_000;
/** Calls allowed per tool invocation (the Worker's subrequest limit does not apply locally). */
const MAX_CALLS = 200;

const SESSION_ENDED =
  'The Moodle session ended. Run "waseda-moodle-mcp connect" again (or update WMM_SESSION), then restart this server.';

/** Runs `task` every `ms` until the returned function is called; never keeps the process alive by itself. */
type Every = (ms: number, task: () => Promise<void>) => () => void;

const everyUnref: Every = (ms, task) => {
  const timer = setInterval(() => void task().catch(() => undefined), ms);
  timer.unref();
  return () => clearInterval(timer);
};

interface LiveConnectionOptions extends LoadedCredential {
  fetch: typeof fetch;
  log: (message: string) => void;
  /** Called when later clients would answer differently (channel or sign-in changed): cached reads are stale. */
  onChange: () => void;
  every?: Every;
}

type SessionOptions = WebMoodleClientOptions['session'];

export class LiveConnection {
  private credential: Credential;
  private moodleUserId = 0;
  /** Assumed on until Moodle says otherwise: the client falls back to the session when it is not. */
  private mobileService = true;
  private stopKeepalive: (() => void) | null = null;
  private stopServiceCheck: (() => void) | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly opts: LiveConnectionOptions) {
    this.credential = opts.credential;
  }

  /** Finds out whose sign-in this is (the session first, else the token) and starts the timers. */
  async start(): Promise<Identity> {
    await this.checkMobileService();
    const who = (await this.sessionIdentity()) ?? (await this.tokenIdentity());
    this.moodleUserId = who.moodleUserId;
    const every = this.opts.every ?? everyUnref;
    if (this.credential.token) this.stopServiceCheck = every(SERVICE_CHECK_MS, () => this.checkMobileService());
    if (this.credential.session) this.stopKeepalive = every(KEEPALIVE_MS, () => this.keepAlive());
    return who;
  }

  stop(): void {
    this.stopKeepalive?.();
    this.stopServiceCheck?.();
  }

  /** Resolves when every queued write of the credential file is done. */
  flush(): Promise<void> {
    return this.writes;
  }

  /** What createChannelClient needs for one invocation. */
  clientOptions(): ChannelClientOptions {
    const { moodleUserId, mobileService } = this;
    const session = this.sessionOptions();
    return {
      moodleUserId,
      mobileService,
      token: this.tokenOptions(),
      session: session ? { session, moodleUserId, maxCalls: MAX_CALLS } : null,
      onMobileServiceOff: async () => this.setMobileService(false),
    };
  }

  private async sessionIdentity(): Promise<Identity | null> {
    const { session } = this.credential;
    if (!session) return null;
    try {
      const { moodleUserId, fullname, lang, sesskey, cookie } = await identifySession(this.opts.fetch, session);
      this.updateSession(session, { cookie, sesskey });
      // never the cookie or sesskey: the identity goes into the local state file
      return { moodleUserId, fullname: fullname || `User ${moodleUserId}`, lang: lang || 'en' };
    } catch (e) {
      if (!(e instanceof NeedsReconnect)) throw e;
      this.endSession(session);
      await this.flush(); // the process may exit right after
      return null;
    }
  }

  private async tokenIdentity(): Promise<Identity> {
    const { token } = this.credential;
    if (!token) throw new NeedsReconnect();
    return identifyToken(token, this.opts.fetch);
  }

  private tokenOptions(): MoodleClientOptions | null {
    const { token } = this.credential;
    if (!token) return null;
    return {
      token,
      moodleUserId: this.moodleUserId,
      fetch: this.opts.fetch,
      maxCalls: MAX_CALLS,
      onTokenInvalid: async (rejected) => this.dropToken(rejected),
    };
  }

  /** Options of one web session object; its updates count only while its cookie is still the current one. */
  private sessionOptions(): SessionOptions | null {
    const { session, sesskey } = this.credential;
    if (!session) return null;
    let cookie = session; // the cookie that object is using
    return {
      cookie,
      sesskey,
      fetch: this.opts.fetch,
      onUpdate: async (update) => {
        this.updateSession(cookie, update);
        cookie = update.cookie ?? cookie;
      },
      onEnded: async () => this.endSession(cookie),
    };
  }

  private async checkMobileService(): Promise<void> {
    if (!this.credential.token) return;
    const on = await mobileServiceEnabled(this.opts.fetch);
    if (on !== null) this.setMobileService(on); // null: unreachable, keep what we knew
  }

  /** A light request that keeps the session from idling out; the session itself reports its end. */
  private async keepAlive(): Promise<void> {
    const options = this.sessionOptions();
    if (!options) return;
    const { moodleUserId } = this;
    try {
      await new MoodleWebSession({ ...options, moodleUserId, charge: () => undefined }).ajax('core_session_touch');
    } catch (e) {
      if (e instanceof NeedsReconnect) return;
      this.opts.log('Could not reach Moodle to keep the session alive; trying again in an hour.');
    }
  }

  private setMobileService(on: boolean): void {
    if (on === this.mobileService) return;
    this.mobileService = on;
    this.opts.onChange();
  }

  private dropToken(rejected: string): void {
    if (this.credential.token !== rejected) return;
    this.credential = { ...this.credential, token: undefined };
    this.opts.onChange();
    this.opts.log(
      this.credential.session ? 'The app token no longer works; using the Moodle session.' : RECONNECT_STDIO,
    );
  }

  private updateSession(from: string, update: { cookie?: string; sesskey?: string }): void {
    if (this.credential.session !== from) return; // a newer cookie replaced it meanwhile
    const session = update.cookie ?? from;
    const sesskey = update.sesskey ?? this.credential.sesskey;
    if (session === from && sesskey === this.credential.sesskey) return;
    this.saveSession(from, { session, sesskey });
  }

  private endSession(ended: string): void {
    if (this.credential.session !== ended) return;
    this.stopKeepalive?.();
    this.saveSession(ended, { session: undefined, sesskey: undefined });
    this.opts.onChange();
    this.opts.log(SESSION_ENDED);
  }

  private saveSession(from: string, change: Pick<Credential, 'session' | 'sesskey'>): void {
    this.credential = { ...this.credential, ...change };
    const { file, log } = this.opts;
    if (!file) {
      if (change.session && change.session !== from) {
        log('Moodle issued a new session cookie; WMM_SESSION will be out of date at the next start.');
      }
      return;
    }
    this.writes = this.writes
      .then(() => replaceSession(file, from, change))
      .catch(() => log(`Could not save the Moodle session to ${file}.`));
  }
}

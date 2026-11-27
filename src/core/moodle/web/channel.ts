/**
 * Channel selection (design r14 "Channel selection"): the token channel ('ws') while the site's mobile service is on
 * and a token exists, the web session ('web') otherwise. When the FIRST call on 'ws' shows the service is off (or
 * the token is dead) and a session exists, the site flag is flipped and that call is repeated on 'web'. The channel
 * is fixed once a call got an answer from Moodle. File downloads and uploads take the same way (an upload whose body
 * is a stream settles the channel with a read first: the stream can be sent only once).
 */

import type { CallHint, DraftUploadResult, MoodleApi, MoodleChannel } from '../../context';
import { MoodleError, NeedsReconnect } from '../../errors';
import { MoodleClient, type MoodleClientOptions } from '../client';
import { MOODLE_URL } from '../launch';
import { isFolderZipUrl, type UploadFile } from '../wire';
import { WebMoodleClient, type WebMoodleClientOptions } from './client';
import type { WebSession } from './types';

export interface ChannelClientOptions {
  moodleUserId: number;
  /** The site flag (tool_mobile_get_public_config enablemobilewebservice). */
  mobileService: boolean;
  token: MoodleClientOptions | null;
  /** null = no web session stored. */
  session: WebMoodleClientOptions | null;
  /** The first call showed the mobile service is off: flip the site flag. Best effort. */
  onMobileServiceOff?: () => Promise<void>;
}

const SERVICE_OFF_MSG =
  'Waseda Moodle turned off the app service. Reconnect with the browser extension or the Moodle session cookie.';
const SERVICE_OFF_CODES = new Set(['accessexception', 'servicenotavailable']);
/** A cheap read of the mobile service that is also ajax-enabled: settles a fresh client's channel. */
const SETTLE_FN = 'core_course_get_recent_courses';

/** A ws answer that means the mobile service is off (token-expiry accessexceptions are NeedsReconnect already). */
const isServiceOff = (e: unknown) => e instanceof MoodleError && SERVICE_OFF_CODES.has(e.errorcode);

class ChannelClient implements MoodleApi {
  readonly moodleUserId: number;
  private readonly opts: ChannelClientOptions;
  private readonly predicted: MoodleChannel;
  private settled: MoodleChannel | null = null;
  /** The pending first ws call; later calls wait for it to settle the channel. */
  private probing: Promise<void> | null = null;
  private wsClient: MoodleClient | null = null;
  private webClient: WebMoodleClient | null = null;

  constructor(opts: ChannelClientOptions) {
    this.opts = opts;
    this.moodleUserId = opts.moodleUserId;
    this.predicted = opts.token && opts.mobileService ? 'ws' : 'web';
  }

  get channel(): MoodleChannel {
    return this.settled ?? this.predicted;
  }

  get baseUrl(): string {
    return (this.opts.session?.session.baseUrl ?? this.opts.token?.baseUrl ?? MOODLE_URL).replace(/\/+$/, '');
  }

  get web(): WebSession | undefined {
    return this.channel === 'web' && this.opts.session ? this.webApi().web : undefined;
  }

  get callsMade(): number {
    return (this.wsClient?.callsMade ?? 0) + (this.webClient?.callsMade ?? 0);
  }

  get writesSent(): number {
    return (this.wsClient?.writesSent ?? 0) + (this.webClient?.writesSent ?? 0);
  }

  private ws(): MoodleClient {
    if (!this.opts.token) throw new NeedsReconnect();
    this.wsClient ??= new MoodleClient(this.opts.token);
    return this.wsClient;
  }

  private webApi(): WebMoodleClient {
    if (!this.opts.session) throw new NeedsReconnect(this.opts.mobileService ? undefined : SERVICE_OFF_MSG);
    this.webClient ??= new WebMoodleClient(this.opts.session);
    return this.webClient;
  }

  private current(): MoodleApi {
    return this.channel === 'ws' ? this.ws() : this.webApi();
  }

  call<T = unknown>(fn: string, params: Record<string, unknown> = {}, hint?: CallHint): Promise<T> {
    return this.run((api) => api.call<T>(fn, params, hint));
  }

  /** A folder's ZIP exists only on the web session: it goes there whenever one is stored, whatever the channel. */
  fetchFile(fileUrl: string, init?: { method?: 'GET' | 'HEAD'; range?: string }): Promise<Response> {
    if (this.opts.session && isFolderZipUrl(this.baseUrl, fileUrl)) return this.webApi().fetchFile(fileUrl, init);
    return this.run((api) => api.fetchFile(fileUrl, init));
  }

  async uploadToDraft(file: UploadFile, itemId: number, hint?: CallHint): Promise<DraftUploadResult> {
    // a stream cannot be sent again on 'web' after 'ws' refused it
    if (!(file.body instanceof Uint8Array) && this.unsettledWs() && this.opts.session) await settleChannel(this);
    return this.run((api) => api.uploadToDraft(file, itemId, hint));
  }

  private unsettledWs(): boolean {
    return !this.settled && this.predicted === 'ws';
  }

  /** Runs one operation on the channel; the first one on 'ws' settles it (later ones wait for that). */
  private async run<T>(op: (api: MoodleApi) => Promise<T>): Promise<T> {
    if (!this.unsettledWs()) return op(this.current());
    if (this.probing) {
      await this.probing;
      return this.run(op);
    }
    const first = this.probe(op);
    this.probing = first.then(
      () => {},
      () => {},
    );
    try {
      return await first;
    } finally {
      this.probing = null;
    }
  }

  /** The first ws operation: settles the channel, or falls back to the web session. */
  private async probe<T>(op: (api: MoodleApi) => Promise<T>): Promise<T> {
    try {
      const out = await op(this.ws());
      this.settled = 'ws';
      return out;
    } catch (e) {
      const off = isServiceOff(e);
      if (!off && !(e instanceof NeedsReconnect && this.opts.session)) {
        if (e instanceof MoodleError) this.settled = 'ws'; // Moodle answered: the service is on
        throw e;
      }
      if (!this.opts.session) throw new NeedsReconnect(SERVICE_OFF_MSG);
      if (off) await this.opts.onMobileServiceOff?.().catch(() => {});
      this.settled = 'web';
      return op(this.webApi());
    }
  }
}

/**
 * Settles the channel of a fresh client that may still fall back from 'ws' to 'web' with one cheap read (before a
 * write whose ids belong to one channel, or a body that can be sent once). A Moodle error still settles it.
 */
export async function settleChannel(api: MoodleApi): Promise<void> {
  if (api.channel !== 'ws' || api.callsMade > 0) return;
  await api.call(SETTLE_FN, { limit: 1 }).catch((e: unknown) => {
    if (!(e instanceof MoodleError)) throw e;
  });
}

/** The MoodleApi of one request for a user with these credentials (see the module comment for the rule). */
export function createChannelClient(opts: ChannelClientOptions): MoodleApi {
  return new ChannelClient(opts);
}

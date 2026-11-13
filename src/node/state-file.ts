/** The local store's JSON state file (mode 0600): read once at start, then rewritten as a whole on each change. */

import { readFileSync } from 'node:fs';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ActionRow, UserRow } from '../core/context';
import { normalizeScheduleOverrides } from '../core/services/schedule-overrides';
import { DEFAULT_SETTINGS, type InferredSchedule, type UserSettings } from '../core/types';

export interface PersistedState {
  version: 1;
  nextUserId: number;
  users: UserRow[];
  actions: ActionRow[];
  /** Kept across restarts so a new session does not start cold: public syllabus rows and the user's inferred times. */
  syllabus?: Record<string, { json: string; fetchedAt: number }>;
  inferred?: Record<string, InferredSchedule>;
}

/**
 * Saved settings in the current shape: drops retired fields; an old file reads no overrides as {} and a missing
 * night / alsoOnDemand as false.
 */
export function restoredSettings(saved: Partial<UserSettings> | undefined): UserSettings {
  const merged = { ...DEFAULT_SETTINGS, ...saved };
  return {
    writeMode: merged.writeMode,
    myCourseIds: merged.myCourseIds ?? null,
    uiLang: merged.uiLang,
    scheduleOverrides: normalizeScheduleOverrides(merged.scheduleOverrides),
  };
}

/**
 * Snapshots go to a tmp file + rename, one after another. The file is owned by one process: when two servers share
 * it, the last writer wins and the other one's changes are lost on its next write.
 */
export class StateFile {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly onError: (error: unknown) => void,
  ) {}

  /** Hands the saved state to `restore`; a missing file is no error, an unreadable or invalid one is reported. */
  load(restore: (data: Partial<PersistedState>) => void): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.onError(e);
      return;
    }
    try {
      restore(JSON.parse(raw) as Partial<PersistedState>);
    } catch (e) {
      this.onError(e);
    }
  }

  write(state: PersistedState): void {
    const { path } = this;
    const json = JSON.stringify(state, null, 2);
    this.chain = this.chain
      .then(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const tmp = `${path}.${process.pid}.tmp`;
        await writeFile(tmp, json, { mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, path);
      })
      .catch((e) => this.onError(e));
  }

  /** Resolves when every queued write has reached the disk. */
  flush(): Promise<void> {
    return this.chain;
  }
}

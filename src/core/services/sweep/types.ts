import type { IsoJst } from '../../types';

export interface SweepStats {
  checked: number; // scope courses whose snapshot was verified within the last 30 minutes
  stale: number; // scope courses served from an older (or no) snapshot
  checkedAt: IsoJst | null; // oldest verification time among the checked courses
}

/** Moodle calls one sweep step may still spend (reservations are synchronous, so parallel use is safe). */
export class CallBudget {
  private left: number;
  constructor(calls: number) {
    this.left = calls;
  }
  take(): boolean {
    if (this.left <= 0) return false;
    this.left--;
    return true;
  }
  get remaining(): number {
    return this.left;
  }
}

export interface CourseRef {
  id: number;
  name: string;
}

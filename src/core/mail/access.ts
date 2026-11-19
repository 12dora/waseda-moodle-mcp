/** Mail access approval (migrations/0013_mail_access.sql): a user applies, an operator decides; operators need none. */

import type { MailCredentialRow } from '../context';

export type MailAccessStatus = 'pending' | 'approved' | 'rejected';
export type MailAccessDecision = Exclude<MailAccessStatus, 'pending'>;

/** A user's application for mail access. */
export interface MailAccessRow {
  userId: number;
  status: MailAccessStatus;
  requestedAt: number;
  decidedAt: number | null;
  /** The deciding operator's Moodle user id. */
  decidedBy: number | null;
}

/** One application in the operator's list, with the applicant and their mail connection (if any). */
export interface MailAccessListItem {
  userId: number;
  fullname: string;
  moodleUserId: number;
  status: MailAccessStatus;
  requestedAt: number;
  decidedAt: number | null;
  connection: { address: string; status: MailCredentialRow['status'] } | null;
}

interface MailAccessListQuery {
  status?: MailAccessStatus;
  limit: number;
  /** Moodle user ids left out (the operators: they need no application). */
  except: readonly number[];
}

/** An operator's decision (`by`: their Moodle user id) taking effect at `at`. */
export interface MailAccessChange {
  status: MailAccessDecision;
  by: number;
  at: number;
  /** The states the row may be in for the change to apply; null = any, a missing row is created (requested at `at`). */
  from: readonly MailAccessStatus[] | null;
}

/** A user holding a mail credential (with or without a token). */
interface MailCredentialOwner {
  userId: number;
  moodleUserId: number;
}

/** The Store's mail access methods (Worker only; the local entry throws). */
export interface MailAccessMethods {
  getMailAccess(userId: number): Promise<MailAccessRow | null>;
  /**
   * Applies for mail access: no row or a rejected one becomes pending (requested at `at`, decision cleared); a pending
   * or approved row stays as it is. Returns the row.
   */
  requestMailAccess(userId: number, at: number): Promise<MailAccessRow>;
  /** Records a decision in one conditional statement; false when the row is missing or in a state not in `from`. */
  decideMailAccess(userId: number, change: MailAccessChange): Promise<boolean>;
  /** Applications (all, or of one status), newest request first. */
  listMailAccess(query: MailAccessListQuery): Promise<MailAccessListItem[]>;
  /** Applications in `status`, without those of the Moodle users in `except` (like listMailAccess). */
  countMailAccess(status: MailAccessStatus, except: readonly number[]): Promise<number>;
  /**
   * Owners of a mail credential whose application is missing or not approved (operators included: the caller leaves
   * them out), by user id.
   */
  listUnapprovedMailOwners(limit: number): Promise<MailCredentialOwner[]>;
}

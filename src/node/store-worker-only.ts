/** Store methods only the Worker implements (secret calendar feeds, the Waseda mail connection): they throw locally. */

const localOnly = async (): Promise<never> => {
  throw new Error('This feature is not available in local mode.');
};

export class WorkerOnlyMethods {
  // secret calendar feeds
  readonly getCalendarFeed = localOnly;
  readonly getCalendarFeedByHash = localOnly;
  readonly replaceCalendarFeed = localOnly;
  readonly deleteCalendarFeed = localOnly;
  readonly recordCalendarFetch = localOnly;

  // Waseda mail connection
  readonly getMailCredential = localOnly;
  readonly putMailCredential = localOnly;
  readonly updateMailCredential = localOnly;
  readonly updateMailCredentialIf = localOnly;
  readonly deleteMailCredential = localOnly;
  readonly listIdleMailCredentials = localOnly;
  readonly countMailSlots = localOnly;
  readonly hasMailSlot = localOnly;
  readonly takeMailSlot = localOnly;
}

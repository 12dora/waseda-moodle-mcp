// Message keys for sync and connect results, shared by the popup and the settings page.

export const RESULT_KEYS = {
  updated: 'resultUpdated',
  unchanged: 'resultUnchanged',
  connect_opened: 'resultConnectOpened',
  signin_required: 'resultSigninRequired',
  unknown_user: 'resultUnknownUser',
  rate_limited: 'resultRateLimited',
  server_error: 'resultServerError',
  moodle_unavailable: 'resultMoodleUnavailable',
  network_error: 'resultNetworkError',
  permission_missing: 'resultPermissionMissing',
};

/** The message for an answer of `wmm:connect`: null when the console was opened. */
export function connectMessageKey(res) {
  if (res?.ok) return null;
  if (res?.error === 'consent_required') return 'hintConsent';
  if (res?.error === 'signin_required') return 'hintSignIn';
  return RESULT_KEYS[res?.error] || 'resultServerError';
}

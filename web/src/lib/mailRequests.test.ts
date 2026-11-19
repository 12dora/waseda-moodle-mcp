import { describe, expect, it } from 'vitest';
import {
  MAIL_REQUEST_STATUSES,
  needsConfirmation,
  parseMailRequestStatus,
  rowActions,
  slotsText,
} from './mailRequests';

describe('rowActions', () => {
  it('offers approve and reject for a pending request, approve first and primary', () => {
    expect(rowActions('pending')).toEqual([
      { action: 'approve', variant: 'primary' },
      { action: 'reject', variant: 'secondary' },
    ]);
  });

  it('offers only revoke for an approved user, as a danger action', () => {
    expect(rowActions('approved')).toEqual([{ action: 'revoke', variant: 'danger' }]);
  });

  it('offers approve again for a rejected request', () => {
    expect(rowActions('rejected').map((a) => a.action)).toEqual(['approve']);
  });

  it('has actions for every filter', () => {
    for (const s of MAIL_REQUEST_STATUSES) expect(rowActions(s).length).toBeGreaterThan(0);
  });
});

describe('needsConfirmation', () => {
  it('asks only before revoking', () => {
    expect(needsConfirmation('revoke')).toBe(true);
    expect(needsConfirmation('approve')).toBe(false);
    expect(needsConfirmation('reject')).toBe(false);
  });
});

describe('slotsText', () => {
  it('shows used/limit when there is a limit', () => {
    expect(slotsText({ used: 12, limit: 100 })).toEqual({ key: 'mail.admin.slots', vars: { used: 12, limit: 100 } });
  });

  it('shows only the used count without a limit', () => {
    expect(slotsText({ used: 3, limit: null })).toEqual({ key: 'mail.admin.slotsNoLimit', vars: { used: 3 } });
  });
});

describe('parseMailRequestStatus', () => {
  it('keeps known filters and defaults to pending', () => {
    expect(parseMailRequestStatus('approved')).toBe('approved');
    expect(parseMailRequestStatus('rejected')).toBe('rejected');
    expect(parseMailRequestStatus(null)).toBe('pending');
    expect(parseMailRequestStatus('none')).toBe('pending');
    expect(parseMailRequestStatus('')).toBe('pending');
  });
});

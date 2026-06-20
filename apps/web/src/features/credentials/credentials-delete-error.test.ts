/**
 * Unit tests for credential deletion error handling.
 *
 * The CredentialsPage deleteMutation has an onError handler that checks for
 * 'credential_in_use' errors and surfaces blocking dependents to the user.
 *
 * These tests verify:
 *   - credential_in_use errors trigger an alert with blocking info
 *   - Non-credential_in_use errors are silently ignored (no alert)
 *   - All three blocking categories are formatted correctly
 *   - Empty/missing params produce empty strings in the message
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError } from '../../lib/api-client.js';

/**
 * Pure-function extraction of the onError handler from CredentialsPage.
 * Mirrors the logic in the deleteMutation.onError callback for deterministic
 * unit testing without React state, useMutation, or intl plumbing.
 */
function handleCredentialDeleteError(
  error: ApiError,
  formatMessage: (id: string, values?: Record<string, unknown>) => string,
  alertFn: (message: string) => void,
): void {
  if (error.code === 'credential_in_use') {
    alertFn(formatMessage('credentials.deleteBlocked', {
      venueAccounts: (error.params?.blockingVenueAccountIds as string[])?.join(', ') ?? '',
      bots: (error.params?.blockingBotIds as string[])?.join(', ') ?? '',
      connections: (error.params?.blockingConnectionIds as string[])?.join(', ') ?? '',
    }));
  }
}

describe('credential delete onError handler', () => {
  let mockFormatMessage: ReturnType<typeof vi.fn>;
  let mockAlert: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFormatMessage = vi.fn().mockImplementation(
      (id: string, values?: Record<string, unknown>) =>
        `${id}: ${JSON.stringify(values ?? {})}`,
    );
    mockAlert = vi.fn();
  });

  it('calls alert with blocking info when error code is credential_in_use', () => {
    const error = new ApiError(409, 'credential_in_use', 'Credential is in use', {
      blockingVenueAccountIds: ['va-1', 'va-2'],
      blockingBotIds: ['bot-1'],
      blockingConnectionIds: ['conn-1'],
    });

    handleCredentialDeleteError(error, mockFormatMessage, mockAlert);

    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(mockFormatMessage).toHaveBeenCalledWith('credentials.deleteBlocked', {
      venueAccounts: 'va-1, va-2',
      bots: 'bot-1',
      connections: 'conn-1',
    });
  });

  it('does not call alert when error code is not credential_in_use', () => {
    const error = new ApiError(500, 'internal_error', 'Something went wrong');

    handleCredentialDeleteError(error, mockFormatMessage, mockAlert);

    expect(mockAlert).not.toHaveBeenCalled();
    expect(mockFormatMessage).not.toHaveBeenCalled();
  });

  it('does not call alert for a 404 not_found error', () => {
    const error = new ApiError(404, 'not_found', 'Credential not found');

    handleCredentialDeleteError(error, mockFormatMessage, mockAlert);

    expect(mockAlert).not.toHaveBeenCalled();
  });

  it('does not call alert for a 403 forbidden error', () => {
    const error = new ApiError(403, 'forbidden', 'Access denied');

    handleCredentialDeleteError(error, mockFormatMessage, mockAlert);

    expect(mockAlert).not.toHaveBeenCalled();
  });

  it('handles missing params gracefully (no blocking info available)', () => {
    const error = new ApiError(409, 'credential_in_use', 'Credential is in use');
    // params is undefined

    handleCredentialDeleteError(error, mockFormatMessage, mockAlert);

    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(mockFormatMessage).toHaveBeenCalledWith('credentials.deleteBlocked', {
      venueAccounts: '',
      bots: '',
      connections: '',
    });
  });

  it('handles partial params — only venue accounts are blocking', () => {
    const error = new ApiError(409, 'credential_in_use', 'Credential is in use', {
      blockingVenueAccountIds: ['va-1'],
    });

    handleCredentialDeleteError(error, mockFormatMessage, mockAlert);

    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(mockFormatMessage).toHaveBeenCalledWith('credentials.deleteBlocked', {
      venueAccounts: 'va-1',
      bots: '',
      connections: '',
    });
  });

  it('handles partial params — only bots are blocking', () => {
    const error = new ApiError(409, 'credential_in_use', 'Credential is in use', {
      blockingBotIds: ['bot-1', 'bot-2'],
    });

    handleCredentialDeleteError(error, mockFormatMessage, mockAlert);

    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(mockFormatMessage).toHaveBeenCalledWith('credentials.deleteBlocked', {
      venueAccounts: '',
      bots: 'bot-1, bot-2',
      connections: '',
    });
  });

  it('handles empty arrays in params', () => {
    const error = new ApiError(409, 'credential_in_use', 'Credential is in use', {
      blockingVenueAccountIds: [],
      blockingBotIds: [],
      blockingConnectionIds: [],
    });

    handleCredentialDeleteError(error, mockFormatMessage, mockAlert);

    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(mockFormatMessage).toHaveBeenCalledWith('credentials.deleteBlocked', {
      venueAccounts: '',
      bots: '',
      connections: '',
    });
  });
});

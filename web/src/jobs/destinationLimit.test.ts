import { describe, expect, it, vi } from 'vitest';
import { blockedDestinationsMessage, tooManyDestinationsMessage, totalSupportedDestinations } from './destinationLimit';

describe('totalSupportedDestinations', () => {
  it('defaults to 20', () => {
    vi.stubEnv('VITE_TOTAL_SUPPORTED_DESTINATIONS', '');
    expect(totalSupportedDestinations()).toBe(20);
    expect(tooManyDestinationsMessage(20)).toBe('You can send to at most 20 destinations');
    expect(blockedDestinationsMessage(20)).toBe(
      'You can send to at most 20 destinations. Uncheck one to choose another',
    );
  });
});

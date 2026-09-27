import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliverySocketUrl } from './wsUrl';

describe('deliverySocketUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the configured WebSocket API and puts the token in the query', () => {
    vi.stubEnv('VITE_WS_URL', 'wss://ws.example.com');
    expect(deliverySocketUrl('abc 123')).toBe('wss://ws.example.com/?token=abc+123');
  });
});

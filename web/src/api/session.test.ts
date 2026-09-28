import { beforeEach, describe, expect, it } from 'vitest';
import { clearSessionTokens, getAccessToken, getRefreshToken, setSessionTokens } from './session';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe('session tokens', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: memoryStorage(),
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: memoryStorage(),
    });
  });

  it('stores access and refresh tokens in sessionStorage only', () => {
    setSessionTokens('access-1', 'refresh-1');

    expect(getAccessToken()).toBe('access-1');
    expect(getRefreshToken()).toBe('refresh-1');
    expect(sessionStorage.getItem('accessToken')).toBe('access-1');
    expect(sessionStorage.getItem('refreshToken')).toBe('refresh-1');
    expect(localStorage.getItem('accessToken')).toBeNull();
    expect(localStorage.getItem('refreshToken')).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('clears both tokens from sessionStorage', () => {
    setSessionTokens('access-1', 'refresh-1');
    clearSessionTokens();

    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });
});

/**
 * @jest-environment jsdom
 */
import { renderHook, act } from '@testing-library/react';
import { usePasskeyWallet, isPasskeyDemoModeEnabled } from '../usePasskeyWallet';

const mockCredential = {
  rawId: new Uint8Array([1, 2, 3, 4]).buffer,
  response: { signature: new Uint8Array([5, 6, 7, 8]).buffer },
};

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, 'PublicKeyCredential', { value: class {}, configurable: true, writable: true });
  Object.defineProperty(navigator, 'credentials', {
    value: { create: jest.fn().mockResolvedValue(mockCredential), get: jest.fn().mockResolvedValue(mockCredential) },
    configurable: true,
  });
  // jsdom already sets window.location.hostname = 'localhost' — no need to redefine
  Object.defineProperty(window, 'crypto', {
    value: { getRandomValues: (arr: Uint8Array) => { arr.fill(1); return arr; } },
    configurable: true,
  });
});

afterEach(() => jest.restoreAllMocks());

describe('usePasskeyWallet', () => {
  it('reports isAvailable when WebAuthn is present', () => {
    const { result } = renderHook(() => usePasskeyWallet());
    expect(result.current.isAvailable).toBe(true);
  });

  it('registers and returns a valid Stellar address', async () => {
    const { result } = renderHook(() => usePasskeyWallet());
    let reg: { address: string; keyId: string } | undefined;
    await act(async () => { reg = await result.current.register('player'); });
    expect(reg!.address).toMatch(/^G[A-Z2-7]{55}$/);
    expect(result.current.isRegistered).toBe(true);
  });

  it('persists to localStorage', async () => {
    const { result } = renderHook(() => usePasskeyWallet());
    await act(async () => { await result.current.register('player'); });
    const stored = JSON.parse(localStorage.getItem('inversearena_passkey')!);
    expect(stored.address).toMatch(/^G[A-Z2-7]{55}$/);
  });

  it('signs a transaction and returns base64', async () => {
    const { result } = renderHook(() => usePasskeyWallet());
    await act(async () => { await result.current.register('player'); });
    let sig: string | undefined;
    await act(async () => { sig = await result.current.sign('AAAAAQ=='); });
    expect(typeof sig).toBe('string');
    expect(sig!.length).toBeGreaterThan(0);
  });

  it('disconnects and clears state', async () => {
    const { result } = renderHook(() => usePasskeyWallet());
    await act(async () => { await result.current.register('player'); });
    act(() => { result.current.disconnect(); });
    expect(result.current.isRegistered).toBe(false);
    expect(result.current.address).toBeNull();
    expect(localStorage.getItem('inversearena_passkey')).toBeNull();
  });

  it('throws when WebAuthn unavailable', async () => {
    Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true, writable: true });
    const { result } = renderHook(() => usePasskeyWallet());
    await expect(result.current.register('player')).rejects.toThrow('WebAuthn / Passkeys are not supported');
  });
});

describe('usePasskeyWallet — demo address derivation is disabled in production (#1281)', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: originalNodeEnv, configurable: true });
  });

  it('isPasskeyDemoModeEnabled is false in production even with NEXT_PUBLIC_PASSKEY_DEMO_MODE=true', () => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', configurable: true });
    // jest.setup.env.ts sets NEXT_PUBLIC_PASSKEY_DEMO_MODE=true; the NODE_ENV
    // check must still win.
    expect(isPasskeyDemoModeEnabled()).toBe(false);
  });

  it('isPasskeyDemoModeEnabled is true outside production (development)', () => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'development', configurable: true });
    expect(isPasskeyDemoModeEnabled()).toBe(true);
  });

  it('rejects registration in a production build even with NEXT_PUBLIC_PASSKEY_DEMO_MODE=true', async () => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', configurable: true });
    const { result } = renderHook(() => usePasskeyWallet());
    await expect(result.current.register('player')).rejects.toThrow(/disabled in production builds/);
  });

  it('allows the demo derivation outside production (development)', async () => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'development', configurable: true });
    const { result } = renderHook(() => usePasskeyWallet());
    const reg = await result.current.register('player');
    expect(reg.address).toMatch(/^G[A-Z2-7]{55}$/);
  });
});

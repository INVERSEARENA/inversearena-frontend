'use client';

import { useState, useCallback } from 'react';

export interface PasskeyWalletState {
  address: string | null;
  keyId: string | null;
  isRegistered: boolean;
  error: string | null;
}

const STORAGE_KEY = 'inversearena_passkey';

function loadStored(): { address: string; keyId: string } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as { address: string; keyId: string }) : null;
  } catch {
    return null;
  }
}

function deriveAddress(credentialId: string): string {
  // Derive a deterministic Stellar-format address (G...) from the credential ID.
  // In production this would be the smart wallet contract address returned by
  // the passkey-kit after deploying a secp256r1 smart wallet on Soroban.
  const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let hash = 0;
  for (let i = 0; i < credentialId.length; i++) {
    hash = ((hash << 5) - hash + credentialId.charCodeAt(i)) | 0;
  }
  let addr = 'G';
  let seed = Math.abs(hash);
  for (let i = 0; i < 55; i++) {
    addr += base32Chars[seed % 32]!;
    seed = Math.abs(((seed * 1103515245 + 12345) | 0));
  }
  return addr;
}

export function usePasskeyWallet() {
  const stored = loadStored();
  const [state, setState] = useState<PasskeyWalletState>({
    address: stored?.address ?? null,
    keyId: stored?.keyId ?? null,
    isRegistered: stored !== null,
    error: null,
  });

  const isAvailable = useCallback((): boolean => {
    return (
      typeof window !== 'undefined' &&
      typeof window.PublicKeyCredential !== 'undefined' &&
      typeof navigator.credentials?.create === 'function'
    );
  }, []);

  const register = useCallback(async (username: string): Promise<{ address: string; keyId: string }> => {
    if (!isAvailable()) {
      throw new Error('WebAuthn / Passkeys are not supported in this browser.');
    }

    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userId = crypto.getRandomValues(new Uint8Array(16));

    const credential = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: 'Inverse Arena', id: window.location.hostname },
        user: { id: userId, name: username, displayName: username },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },   // ES256 (secp256r1)
          { type: 'public-key', alg: -257 },  // RS256 fallback
        ],
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'required',
        },
        timeout: 60000,
      },
    }) as PublicKeyCredential | null;

    if (!credential) throw new Error('Passkey registration was cancelled.');

    const keyId = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)));
    const address = deriveAddress(keyId);

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ address, keyId }));
    setState({ address, keyId, isRegistered: true, error: null });
    return { address, keyId };
  }, [isAvailable]);

  const sign = useCallback(async (txXdr: string): Promise<string> => {
    if (!state.keyId) throw new Error('No passkey registered. Call register() first.');
    if (!isAvailable()) throw new Error('WebAuthn is not available.');

    const challenge = new TextEncoder().encode(txXdr).buffer as ArrayBuffer;

    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        userVerification: 'required',
        timeout: 60000,
      },
    }) as PublicKeyCredential | null;

    if (!assertion) throw new Error('Passkey signing was cancelled.');

    const response = assertion.response as AuthenticatorAssertionResponse;
    // Return the signature as base64 — the Soroban smart wallet contract
    // verifies the secp256r1 signature on-chain.
    return btoa(String.fromCharCode(...new Uint8Array(response.signature)));
  }, [state.keyId, isAvailable]);

  const disconnect = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setState({ address: null, keyId: null, isRegistered: false, error: null });
  }, []);

  return {
    ...state,
    isAvailable: isAvailable(),
    register,
    sign,
    disconnect,
  };
}

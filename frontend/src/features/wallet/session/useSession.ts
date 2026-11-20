"use client";

import { useCallback, useEffect, useState } from "react";

import { useWallet } from "../hooks/useWallet";
import {
  loginWithWallet,
  logoutSession,
  scheduleRefresh,
} from "@/shared/lib/session/sessionClient";
import { getSessionState, subscribeSession } from "@/shared/lib/session/sessionStore";
import type { SessionState } from "@/shared/lib/session/types";

export interface UseSessionResult extends SessionState {
  /** Requests a challenge, signs it with the connected wallet and logs in. */
  login: () => Promise<void>;
  /** Revokes the backend session and clears local token state. */
  logout: () => Promise<void>;
  isAuthenticated: boolean;
}

/**
 * Backend wallet-session state machine for the connected wallet.
 *
 * `login()` and `logout()` are the only supported transitions; token storage,
 * rotation and cross-tab sync are owned by the session client/store.
 */
export function useSession(): UseSessionResult {
  const wallet = useWallet();
  const [state, setState] = useState<SessionState>(() => getSessionState());

  useEffect(() => subscribeSession(setState), []);
  useEffect(() => {
    scheduleRefresh();
  }, []);

  const login = useCallback(async () => {
    if (!wallet.address) throw new Error("Connect a wallet before signing in");
    if (!wallet.signMessage && !wallet.signTransaction) {
      throw new Error("Connected wallet cannot sign an authentication challenge");
    }
    await loginWithWallet(
      {
        walletAddress: wallet.address,
        ...(wallet.signMessage ? { signMessage: wallet.signMessage } : {}),
        signTransaction: wallet.signTransaction,
      },
      wallet.network,
    );
  }, [wallet]);

  const logout = useCallback(async () => {
    await logoutSession();
  }, []);

  return {
    ...state,
    login,
    logout,
    isAuthenticated: state.status === "authenticated",
  };
}

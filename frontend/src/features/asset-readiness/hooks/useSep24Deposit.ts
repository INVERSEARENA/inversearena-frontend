"use client";

/**
 * SEP-24 deposit hook for asset-readiness (#1734).
 *
 * When asset-readiness reports that the player has no stake asset, this hook
 * provides the entry point to launch a SEP-24 interactive deposit against the
 * configured anchor. It manages the popup, polls the transaction until
 * completion, and then signals the asset-readiness gate to re-check the
 * balance.
 *
 * Feature-flagged per network: only enabled on testnet.
 *
 * @module
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getAnchorConfig,
  runSep24DepositFlow,
  resumePendingDeposit,
  loadPendingDeposit,
  clearPendingDeposit,
  openDepositPopup,
  type Sep24FlowResult,
  type Sep24DepositParams,
} from "@/shared/lib/stellar/sep24";
import { useWallet } from "@/features/wallet";

export type Sep24Phase =
  | "idle"
  | "discovering"
  | "authenticating"
  | "initiating"
  | "popup_open"
  | "polling"
  | "completed"
  | "failed";

export interface Sep24DepositState {
  phase: Sep24Phase;
  /** The transaction id once the deposit is initiated. */
  transactionId: string | null;
  /** Deposit amount from the anchor. */
  amountIn: string | null;
  /** Error message if the flow failed. */
  errorMessage: string | null;
  /** True when a deposit is in progress (for disabling the join button). */
  inProgress: boolean;
  /** Fallback URL if the popup was blocked. */
  fallbackUrl: string | null;
}

export interface UseSep24DepositOptions {
  /** Current Stellar network (testnet or mainnet). */
  network: "testnet" | "mainnet" | undefined;
  /** Asset code the player needs (e.g. "USDC"). */
  assetCode: string | undefined;
  /** Amount to deposit, if known. */
  amount?: string;
  /** Called when the deposit completes, so asset-readiness can re-check. */
  onComplete?: () => void;
}

export function useSep24Deposit({
  network,
  assetCode,
  amount,
  onComplete,
}: UseSep24DepositOptions) {
  const { publicKey, address, isConnected } = useWallet();
  const account = publicKey ?? address;
  const [state, setState] = useState<Sep24DepositState>({
    phase: "idle",
    transactionId: null,
    amountIn: null,
    errorMessage: null,
    inProgress: false,
    fallbackUrl: null,
  });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Check for a pending deposit on mount (resume across reloads)
  useEffect(() => {
    if (!isConnected || !network) return;

    const pending = loadPendingDeposit();
    if (!pending) return;
    if (account && pending.walletAddress !== account) {
      // Different wallet — clear stale pending deposit
      clearPendingDeposit();
      return;
    }

    // Resume the pending deposit
    setState((prev) => ({
      ...prev,
      phase: "polling",
      transactionId: pending.transactionId,
      inProgress: true,
    }));

    void (async () => {
      const result = await resumePendingDeposit();
      if (!mounted.current) return;

      if (result?.success) {
        setState({
          phase: "completed",
          transactionId: result.transactionId,
          amountIn: result.amountIn,
          errorMessage: null,
          inProgress: false,
          fallbackUrl: null,
        });
        onComplete?.();
      } else if (result && !result.success) {
        setState({
          phase: "failed",
          transactionId: result.transactionId,
          amountIn: result.amountIn,
          errorMessage: result.errorMessage,
          inProgress: false,
          fallbackUrl: null,
        });
      }
    })();
  }, [isConnected, network, account, onComplete]);

  const startDeposit = useCallback(async () => {
    if (!isConnected || !account || !network || !assetCode) return;
    if (state.inProgress) return;

    const anchor = getAnchorConfig(network);
    if (!anchor || !anchor.enabled) return;

    setState({
      phase: "discovering",
      transactionId: null,
      amountIn: null,
      errorMessage: null,
      inProgress: true,
      fallbackUrl: null,
    });

    try {
      const result = await runSep24DepositFlow({
        walletAddress: account,
        assetCode,
        amount,
        anchor,
      });

      if (!mounted.current) return;

      if (result.success) {
        setState({
          phase: "completed",
          transactionId: result.transactionId,
          amountIn: result.amountIn,
          errorMessage: null,
          inProgress: false,
          fallbackUrl: null,
        });
        onComplete?.();
      } else {
        setState({
          phase: "failed",
          transactionId: result.transactionId,
          amountIn: result.amountIn,
          errorMessage: result.errorMessage,
          inProgress: false,
          fallbackUrl: null,
        });
      }
    } catch (error) {
      if (!mounted.current) return;
      setState({
        phase: "failed",
        transactionId: null,
        amountIn: null,
        errorMessage: error instanceof Error ? error.message : "SEP-24 deposit failed",
        inProgress: false,
        fallbackUrl: null,
      });
    }
  }, [isConnected, account, network, assetCode, amount, state.inProgress, onComplete]);

  const reset = useCallback(() => {
    setState({
      phase: "idle",
      transactionId: null,
      amountIn: null,
      errorMessage: null,
      inProgress: false,
      fallbackUrl: null,
    });
  }, []);

  return {
    ...state,
    startDeposit,
    reset,
    /** True when SEP-24 is available for this network. */
    available: network === "testnet" && assetCode !== undefined,
  };
}

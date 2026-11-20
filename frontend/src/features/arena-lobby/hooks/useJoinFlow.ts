"use client";

/**
 * useJoinFlow — slot reservation and join/leave transaction flow (#1604).
 *
 * Extracted from ArenaLobbyClient so the transaction + reservation logic
 * can be unit-tested independently and the parent stays thin. #1716 adds an
 * optional strict-receive quote so a player holding a different asset can fund
 * the entry in the same signed transaction.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Transaction } from "@stellar/stellar-sdk";
import { useTransactionIntent } from "@/shared/lib/hooks/useTransactionIntent";
import {
  buildJoinArenaTransaction,
  buildJoinWithPathPaymentTransaction,
  buildLeaveArenaTransaction,
  buildPathPaymentTransaction,
  submitSignedTransaction,
  NETWORK_PASSPHRASE,
} from "@/shared/lib/stellar/stellar-transactions";
import {
  evaluateSigningRequest,
  SigningPolicyError,
  type DecodedEnvelope,
  type ProtectedOpKey,
} from "@/shared/lib/security/policy";
import { useAssetReadinessGate } from "@/features/asset-readiness";
import {
  amountToStroops,
  displayAmountToStroops,
  stroopsToAmount,
  type AssetDescriptor,
} from "@/shared/lib/stellar/stellar-asset-reader";
import {
  assetDescriptorEquals,
  fetchBestStrictReceiveQuote,
  isPathQuoteStale,
  PathQuoteError,
  DEFAULT_PATH_SLIPPAGE_BPS,
  type PathQuote,
} from "@/shared/lib/stellar/path-payment-quote";
import { resolveStakeAsset } from "@/features/asset-readiness/model/stake-asset";
import { getJoinArenaFee } from "@/shared/lib/stellar/stellar-fee-estimator";
import { isStellarConfigured, stellarConfig } from "@/shared/config/stellarConfig";
import type { TransactionProgress } from "@/components/modals/TransactionModal";
import type { ArenaStats } from "./useLobbyData";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : fallback;
}

function looksLikeStalePath(error: unknown): boolean {
  const message = errorMessage(error, "").toLowerCase();
  return (
    message.includes("no path") ||
    message.includes("path_payment_strict_receive_no_path") ||
    (message.includes("quote") && message.includes("expir"))
  );
}

function authHeaders(): HeadersInit {
  const token =
    typeof window !== "undefined"
      ? window.localStorage.getItem("access_token")
      : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type JoinFundingMode = "direct" | "bundled" | "two_step";

export interface UseJoinFlowProps {
  arenaId: string;
  stats: ArenaStats | null;
  wallet: {
    publicKey: string | null | undefined;
    isConnected: boolean;
    signTransaction: (xdr: string) => Promise<string>;
  };
  onJoinSuccess: () => Promise<void>;
  onLeaveSuccess: () => Promise<void>;
}

export interface UseJoinFlowResult {
  showJoinModal: boolean;
  showLeaveModal: boolean;
  joinError: string | null;
  leaveError: string | null;
  joinConfirmation: DecodedEnvelope | null;
  isReserving: boolean;
  reservationError: string | null;
  showTrustline: boolean;
  assetGate: ReturnType<typeof useAssetReadinessGate>;
  sourceAssetGate: ReturnType<typeof useAssetReadinessGate>;
  sourceAssets: readonly AssetDescriptor[];
  selectedSourceCode: string | null;
  pathQuote: PathQuote | null;
  isQuotingPath: boolean;
  pathQuoteError: string | null;
  fundingMode: JoinFundingMode;
  preferTwoStep: boolean;
  networkFeeStroops: string;
  selectSourceAsset: (code: string | null) => void;
  setPreferTwoStep: (value: boolean) => void;
  refreshPathQuote: () => Promise<void>;
  handleJoinClick: () => Promise<void>;
  handleCloseJoinModal: () => void;
  handleConfirmJoin: (
    progress: TransactionProgress,
    options?: { twoStep?: boolean },
  ) => Promise<void>;
  handleConfirmLeave: (progress: TransactionProgress) => Promise<void>;
  openLeaveModal: () => void;
  closeLeaveModal: () => void;
  setShowTrustline: (v: boolean) => void;
}

export function useJoinFlow({
  arenaId,
  stats,
  wallet,
  onJoinSuccess,
  onLeaveSuccess,
}: UseJoinFlowProps): UseJoinFlowResult {
  const { runTrackedTransaction } = useTransactionIntent();
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [showLeaveModal, setShowLeaveModal] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [joinConfirmation, setJoinConfirmation] =
    useState<DecodedEnvelope | null>(null);
  const [isReserving, setIsReserving] = useState(false);
  const [reservationError, setReservationError] = useState<string | null>(null);
  const [showTrustline, setShowTrustline] = useState(false);
  const [selectedSourceCode, setSelectedSourceCode] = useState<string | null>(null);
  const [pathQuote, setPathQuote] = useState<PathQuote | null>(null);
  const [isQuotingPath, setIsQuotingPath] = useState(false);
  const [pathQuoteError, setPathQuoteError] = useState<string | null>(null);
  const [fundingMode, setFundingMode] = useState<JoinFundingMode>("direct");
  const [preferTwoStep, setPreferTwoStep] = useState(false);

  const entryFeeStroops = useMemo(
    () => (stats ? displayAmountToStroops(stats.entryFee) : 0n),
    [stats],
  );

  const sourceAssets = useMemo<AssetDescriptor[]>(() => {
    const assets: AssetDescriptor[] = [{ kind: "native", code: "XLM" }];
    if (!isStellarConfigured) return assets;
    for (const [code, issuer] of Object.entries(stellarConfig.assetIssuers)) {
      if (typeof issuer === "string" && issuer.length > 0) {
        assets.push({ kind: "credit", code, issuer });
      }
    }
    return assets;
  }, []);

  const destinationAsset = useMemo<AssetDescriptor | null>(() => {
    if (!stats?.stakeToken) return null;
    const issuers = isStellarConfigured ? stellarConfig.assetIssuers : {};
    const resolution = resolveStakeAsset(stats.stakeToken, issuers);
    return resolution.kind === "resolved" ? resolution.asset : null;
  }, [stats?.stakeToken]);

  const selectedSourceAsset = useMemo(
    () => sourceAssets.find((asset) => asset.code === selectedSourceCode) ?? null,
    [selectedSourceCode, sourceAssets],
  );
  const usesPathPayment = Boolean(
    selectedSourceAsset &&
      destinationAsset &&
      !assetDescriptorEquals(selectedSourceAsset, destinationAsset),
  );

  const sourceAmountStroops = useMemo(() => {
    if (pathQuote) return amountToStroops(pathQuote.sourceAmount);
    return entryFeeStroops;
  }, [pathQuote, entryFeeStroops]);

  const assetGate = useAssetReadinessGate({
    assetCode: stats?.stakeToken,
    amountStroops: entryFeeStroops,
    entryPoint: "join",
    enabled: Boolean(stats?.stakeToken),
  });
  const sourceAssetGate = useAssetReadinessGate({
    assetCode: selectedSourceAsset?.code,
    amountStroops: sourceAmountStroops,
    entryPoint: "join",
    enabled: usesPathPayment,
  });
  const activeGate = usesPathPayment ? sourceAssetGate : assetGate;

  const fetchPathQuote = useCallback(async (): Promise<PathQuote | null> => {
    if (
      !usesPathPayment ||
      !selectedSourceAsset ||
      !destinationAsset ||
      !wallet.publicKey ||
      entryFeeStroops <= 0n
    ) {
      return null;
    }
    const quote = await fetchBestStrictReceiveQuote({
      horizonBaseUrl: stellarConfig.horizonUrl,
      sourceAssets: [selectedSourceAsset],
      destinationAsset,
      destinationAmount: stroopsToAmount(entryFeeStroops),
      slippageBps: DEFAULT_PATH_SLIPPAGE_BPS,
    });
    if (isPathQuoteStale(quote)) {
      throw new PathQuoteError("stale", "The payment quote expired before it could be used");
    }
    return quote;
  }, [
    usesPathPayment,
    selectedSourceAsset,
    destinationAsset,
    wallet.publicKey,
    entryFeeStroops,
  ]);

  const refreshPathQuoteInternal = useCallback(async (): Promise<PathQuote | null> => {
    if (!usesPathPayment) {
      setPathQuote(null);
      setPathQuoteError(null);
      return null;
    }
    setIsQuotingPath(true);
    setPathQuoteError(null);
    try {
      const quote = await fetchPathQuote();
      setPathQuote(quote);
      return quote;
    } catch (error) {
      setPathQuote(null);
      setPathQuoteError(errorMessage(error, "Unable to quote a payment path"));
      throw error;
    } finally {
      setIsQuotingPath(false);
    }
  }, [fetchPathQuote, usesPathPayment]);

  const refreshPathQuote = useCallback(async (): Promise<void> => {
    await refreshPathQuoteInternal();
  }, [refreshPathQuoteInternal]);

  useEffect(() => {
    if (!showJoinModal || !usesPathPayment) return;
    void refreshPathQuote().catch(() => undefined);
  }, [showJoinModal, usesPathPayment, refreshPathQuote]);

  const reserveJoinSlot = async (): Promise<boolean> => {
    setIsReserving(true);
    setReservationError(null);
    try {
      const response = await fetch(
        `${API_BASE}/api/arenas/${arenaId}/reservation`,
        { method: "POST", headers: authHeaders() },
      );
      if (response.status === 409) {
        setReservationError("This arena has no open slots right now.");
        return false;
      }
      if (!response.ok) {
        throw new Error(`Reservation request failed (${response.status})`);
      }
      return true;
    } catch (reserveError) {
      setReservationError(
        errorMessage(reserveError, "Failed to reserve a slot in this arena."),
      );
      return false;
    } finally {
      setIsReserving(false);
    }
  };

  const releaseJoinSlot = () => {
    void fetch(`${API_BASE}/api/arenas/${arenaId}/reservation`, {
      method: "DELETE",
      headers: authHeaders(),
    }).catch(() => undefined);
  };

  const selectSourceAsset = (code: string | null) => {
    setSelectedSourceCode(code);
    setPathQuote(null);
    setPathQuoteError(null);
    setFundingMode(code ? "bundled" : "direct");
  };

  const handleJoinClick = async () => {
    if (!activeGate.canProceed) {
      if (activeGate.phase === "remediation_offered") setShowTrustline(true);
      return;
    }
    const reserved = await reserveJoinSlot();
    if (reserved) setShowJoinModal(true);
  };

  const handleCloseJoinModal = () => {
    setShowJoinModal(false);
    releaseJoinSlot();
  };

  const runTrackedJoin = async (
    buildTransaction: () => Promise<Transaction>,
    policyKey: ProtectedOpKey,
    actionKey: string,
    onSigned: () => void,
  ): Promise<boolean> => {
    let policyRejected = false;
    await runTrackedTransaction({
      kind: "join_arena",
      actionKey,
      publicKey: wallet.publicKey!,
      buildTransaction: async () => {
        const unsignedTx = await buildTransaction();
        let decoded: DecodedEnvelope;
        try {
          decoded = evaluateSigningRequest(unsignedTx.toXDR(), policyKey);
        } catch (error) {
          if (error instanceof SigningPolicyError) {
            policyRejected = true;
            setJoinError(error.message);
          }
          throw error;
        }
        setJoinConfirmation(decoded);
        return unsignedTx;
      },
      signTransaction: wallet.signTransaction,
      submitSignedTransaction,
      networkPassphrase: NETWORK_PASSPHRASE,
      onSigned,
    }).catch((error) => {
      if (policyRejected) return;
      throw error;
    });
    return !policyRejected;
  };

  const handleConfirmJoin = async (
    { onSigned }: TransactionProgress,
    options?: { twoStep?: boolean },
  ) => {
    if (!wallet.publicKey) {
      throw new Error("Connect a wallet before joining this arena.");
    }
    if (!activeGate.canProceed) {
      setJoinError(activeGate.message);
      if (activeGate.phase === "remediation_offered") setShowTrustline(true);
      return;
    }
    setJoinError(null);

    let quote = pathQuote;
    if (quote && isPathQuoteStale(quote)) {
      quote = await refreshPathQuoteInternal();
      if (quote === null) {
        throw new PathQuoteError("stale", "The payment quote expired — check the quote again");
      }
    }

    if (quote && (options?.twoStep ?? preferTwoStep) !== true) {
      setFundingMode("bundled");
      try {
        const bundled = await runTrackedJoin(
          () => buildJoinWithPathPaymentTransaction(wallet.publicKey!, arenaId, quote!),
          "JOIN_PATH",
          `join_path:${arenaId}`,
          onSigned,
        );
        if (bundled) {
          await onJoinSuccess();
          setShowJoinModal(false);
          return;
        }
      } catch (error) {
        if (looksLikeStalePath(error)) {
          setPathQuote(null);
          setPathQuoteError(
            "The payment path disappeared before confirmation. Check the quote again.",
          );
        }
        throw error;
      }
    }

    if (quote) {
      // Bundling was rejected by the signing firewall (or explicitly skipped):
      // track the swap and the join as two resumable intents instead. The
      // policy error belongs to the abandoned attempt, not to the retry.
      setJoinError(null);
      setFundingMode("two_step");
      const funded = await runTrackedJoin(
        () => buildPathPaymentTransaction(wallet.publicKey!, quote!),
        "PATH_PAYMENT",
        `join_funding:${arenaId}`,
        onSigned,
      );
      if (!funded) return;
    } else {
      setFundingMode("direct");
    }

    const joined = await runTrackedJoin(
      () => buildJoinArenaTransaction(wallet.publicKey!, arenaId),
      "JOIN",
      `join_arena:${arenaId}`,
      onSigned,
    );
    if (!joined) return;
    await onJoinSuccess();
    setShowJoinModal(false);
  };

  const handleConfirmLeave = async ({ onSigned }: TransactionProgress) => {
    if (!wallet.publicKey) {
      throw new Error("Connect a wallet before leaving this arena.");
    }
    setLeaveError(null);
    let policyRejected = false;
    await runTrackedTransaction({
      kind: "leave_arena",
      actionKey: `leave_arena:${arenaId}`,
      publicKey: wallet.publicKey,
      buildTransaction: async () => {
        const unsignedTx = await buildLeaveArenaTransaction(
          wallet.publicKey!,
          arenaId,
        );
        try {
          evaluateSigningRequest(unsignedTx.toXDR(), "REFUND");
        } catch (error) {
          if (error instanceof SigningPolicyError) {
            policyRejected = true;
            setLeaveError(error.message);
          }
          throw error;
        }
        return unsignedTx;
      },
      signTransaction: wallet.signTransaction,
      submitSignedTransaction,
      networkPassphrase: NETWORK_PASSPHRASE,
      onSigned,
    }).catch((error) => {
      if (policyRejected) return;
      throw error;
    });
    if (policyRejected) return;
    await onLeaveSuccess();
    setShowLeaveModal(false);
  };

  return {
    showJoinModal,
    showLeaveModal,
    joinError,
    leaveError,
    joinConfirmation,
    isReserving,
    reservationError,
    showTrustline,
    assetGate,
    sourceAssetGate,
    sourceAssets,
    selectedSourceCode,
    pathQuote,
    isQuotingPath,
    pathQuoteError,
    fundingMode,
    preferTwoStep,
    networkFeeStroops: getJoinArenaFee(),
    selectSourceAsset,
    setPreferTwoStep,
    refreshPathQuote,
    handleJoinClick,
    handleCloseJoinModal,
    handleConfirmJoin,
    handleConfirmLeave,
    openLeaveModal: () => setShowLeaveModal(true),
    closeLeaveModal: () => {
      setShowLeaveModal(false);
      setLeaveError(null);
    },
    setShowTrustline,
  };
}

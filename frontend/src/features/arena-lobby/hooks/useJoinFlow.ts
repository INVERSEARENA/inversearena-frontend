"use client";

/**
 * useJoinFlow — slot reservation and join/leave transaction flow (#1604).
 *
 * Extracted from ArenaLobbyClient so the transaction + reservation logic
 * can be unit-tested independently and the parent stays thin.
 */

import { useMemo, useState } from "react";
import { useTransactionIntent } from "@/shared/lib/hooks/useTransactionIntent";
import {
  buildJoinArenaForTransaction,
  buildJoinArenaTransaction,
  buildLeaveArenaTransaction,
  submitSignedTransaction,
  NETWORK_PASSPHRASE,
} from "@/shared/lib/stellar/stellar-transactions";
import {
  evaluateSigningRequest,
  SigningPolicyError,
  type DecodedEnvelope,
} from "@/shared/lib/security/policy";
import { useAssetReadinessGate } from "@/features/asset-readiness";
import { displayAmountToStroops } from "@/shared/lib/stellar/stellar-asset-reader";
import { tryParseStellarAccountId } from "@/shared/lib/identity-value-objects";
import { apiClient, ApiError } from "@/shared/lib/api/client";
import type { TransactionProgress } from "@/components/modals/TransactionModal";
import type { ArenaStats } from "./useLobbyData";

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
  showGiftModal: boolean;
  giftRecipient: string;
  giftError: string | null;
  joinError: string | null;
  leaveError: string | null;
  joinConfirmation: DecodedEnvelope | null;
  giftConfirmation: DecodedEnvelope | null;
  isReserving: boolean;
  reservationError: string | null;
  showTrustline: boolean;
  assetGate: ReturnType<typeof useAssetReadinessGate>;
  handleJoinClick: () => Promise<void>;
  handleCloseJoinModal: () => void;
  handleConfirmJoin: (progress: TransactionProgress) => Promise<void>;
  handleConfirmGift: (progress: TransactionProgress) => Promise<void>;
  handleConfirmLeave: (progress: TransactionProgress) => Promise<void>;
  setGiftRecipient: (value: string) => void;
  openGiftModal: () => Promise<void>;
  closeGiftModal: () => void;
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
  const [showGiftModal, setShowGiftModal] = useState(false);
  const [giftRecipient, setGiftRecipient] = useState("");
  const [giftError, setGiftError] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [joinConfirmation, setJoinConfirmation] =
    useState<DecodedEnvelope | null>(null);
  const [giftConfirmation, setGiftConfirmation] =
    useState<DecodedEnvelope | null>(null);
  const [isReserving, setIsReserving] = useState(false);
  const [reservationError, setReservationError] = useState<string | null>(null);
  const [showTrustline, setShowTrustline] = useState(false);

  const entryFeeStroops = useMemo(
    () => (stats ? displayAmountToStroops(stats.entryFee) : 0n),
    [stats],
  );
  const assetGate = useAssetReadinessGate({
    assetCode: stats?.stakeToken,
    amountStroops: entryFeeStroops,
    entryPoint: "join",
    enabled: Boolean(stats?.stakeToken),
  });

  const reserveJoinSlot = async (): Promise<boolean> => {
    setIsReserving(true);
    setReservationError(null);
    try {
      await apiClient.post(`/api/arenas/${arenaId}/reservation`);
      return true;
    } catch (reserveError) {
      if (reserveError instanceof ApiError && reserveError.status === 409) {
        setReservationError("This arena has no open slots right now.");
        return false;
      }
      setReservationError(
        reserveError instanceof Error
          ? reserveError.message
          : "Failed to reserve a slot in this arena.",
      );
      return false;
    } finally {
      setIsReserving(false);
    }
  };

  const releaseJoinSlot = () => {
    void apiClient
      .delete(`/api/arenas/${arenaId}/reservation`)
      .catch(() => undefined);
  };

  const handleJoinClick = async () => {
    if (!assetGate.canProceed) {
      if (assetGate.phase === "remediation_offered") setShowTrustline(true);
      return;
    }
    const reserved = await reserveJoinSlot();
    if (reserved) setShowJoinModal(true);
  };

  const handleCloseJoinModal = () => {
    setShowJoinModal(false);
    releaseJoinSlot();
  };

  /** #1715: reserve a slot, then ask for the recipient before building a tx. */
  const openGiftModal = async () => {
    if (!assetGate.canProceed) {
      if (assetGate.phase === "remediation_offered") setShowTrustline(true);
      return;
    }
    const reserved = await reserveJoinSlot();
    if (reserved) {
      setGiftError(null);
      setShowGiftModal(true);
    }
  };

  const closeGiftModal = () => {
    setShowGiftModal(false);
    setGiftError(null);
    setGiftConfirmation(null);
    releaseJoinSlot();
  };

  const handleConfirmGift = async ({ onSigned }: TransactionProgress) => {
    if (!wallet.publicKey) {
      throw new Error("Connect a wallet before gifting a seat.");
    }
    const recipient = tryParseStellarAccountId(giftRecipient.trim());
    if (!recipient) {
      const message = "Enter a valid Stellar account address for the recipient.";
      setGiftError(message);
      throw new Error(message);
    }
    if (!assetGate.canProceed) {
      setGiftError(assetGate.message);
      if (assetGate.phase === "remediation_offered") setShowTrustline(true);
      throw new Error(assetGate.message);
    }
    setGiftError(null);
    let policyRejected = false;
    await runTrackedTransaction({
      kind: "join_arena",
      actionKey: `join_arena_for:${arenaId}:${recipient}`,
      publicKey: wallet.publicKey,
      buildTransaction: async () => {
        const unsignedTx = await buildJoinArenaForTransaction(
          wallet.publicKey!,
          recipient,
          arenaId,
        );
        let decoded: DecodedEnvelope;
        try {
          decoded = evaluateSigningRequest(unsignedTx.toXDR(), "JOIN");
        } catch (error) {
          if (error instanceof SigningPolicyError) {
            policyRejected = true;
            setGiftError(error.message);
          }
          throw error;
        }
        setGiftConfirmation(decoded);
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
    await onJoinSuccess();
    setShowGiftModal(false);
    setGiftRecipient("");
  };

  const handleConfirmJoin = async ({ onSigned }: TransactionProgress) => {
    if (!wallet.publicKey) {
      throw new Error("Connect a wallet before joining this arena.");
    }
    if (!assetGate.canProceed) {
      setJoinError(assetGate.message);
      if (assetGate.phase === "remediation_offered") setShowTrustline(true);
      return;
    }
    setJoinError(null);
    let policyRejected = false;
    await runTrackedTransaction({
      kind: "join_arena",
      actionKey: `join_arena:${arenaId}`,
      publicKey: wallet.publicKey,
      buildTransaction: async () => {
        const unsignedTx = await buildJoinArenaTransaction(
          wallet.publicKey!,
          arenaId,
        );
        let decoded: DecodedEnvelope;
        try {
          decoded = evaluateSigningRequest(unsignedTx.toXDR(), "JOIN");
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
    if (policyRejected) return;
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
    showGiftModal,
    giftRecipient,
    giftError,
    joinError,
    leaveError,
    joinConfirmation,
    giftConfirmation,
    isReserving,
    reservationError,
    showTrustline,
    assetGate,
    handleJoinClick,
    handleCloseJoinModal,
    handleConfirmJoin,
    handleConfirmGift,
    handleConfirmLeave,
    setGiftRecipient,
    openGiftModal,
    closeGiftModal,
    openLeaveModal: () => setShowLeaveModal(true),
    closeLeaveModal: () => {
      setShowLeaveModal(false);
      setLeaveError(null);
    },
    setShowTrustline,
  };
}

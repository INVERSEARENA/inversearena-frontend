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
import type { TransactionProgress } from "@/components/modals/TransactionModal";
import type { ArenaStats } from "./useLobbyData";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

function authHeaders(): HeadersInit {
  const token =
    typeof window !== "undefined"
      ? window.localStorage.getItem("access_token")
      : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

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
  handleJoinClick: () => Promise<void>;
  handleCloseJoinModal: () => void;
  handleConfirmJoin: (progress: TransactionProgress) => Promise<void>;
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
    void fetch(`${API_BASE}/api/arenas/${arenaId}/reservation`, {
      method: "DELETE",
      headers: authHeaders(),
    }).catch(() => undefined);
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
    joinError,
    leaveError,
    joinConfirmation,
    isReserving,
    reservationError,
    showTrustline,
    assetGate,
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

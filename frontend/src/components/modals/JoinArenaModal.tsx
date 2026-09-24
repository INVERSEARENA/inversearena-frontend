"use client";
import React, { useState, useEffect, useRef } from 'react';
import { Modal } from '../ui/Modal';

interface StakeLimitInfo {
  currentActiveStake: number;
  limit: number;
  remainingCapacity: number;
  limitExceeded: boolean;
}

interface JoinArenaModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  arenaId: number;
  requiredStake: number;
  currentPlayers: number;
  maxPlayers: number;
  yieldGeneration: number;
  arenaStatus: 'ACTIVE' | 'INACTIVE';
  /** Optional pre-fetched stake limit info. If omitted the modal fetches it. */
  stakeLimitInfo?: StakeLimitInfo | null;
}

const JoinArenaModal: React.FC<JoinArenaModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  arenaId,
  requiredStake,
  currentPlayers,
  maxPlayers,
  yieldGeneration,
  arenaStatus,
  stakeLimitInfo: externalStakeLimitInfo,
}) => {
  const [isChecked, setIsChecked] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // ── Responsible game limits (#1411) ──────────────────────────────────────
  const [stakeLimitInfo, setStakeLimitInfo] = useState<StakeLimitInfo | null>(
    externalStakeLimitInfo ?? null,
  );
  const [stakeLimitLoading, setStakeLimitLoading] = useState(false);
  const [stakeLimitError, setStakeLimitError] = useState<string | null>(null);

  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;

    if (isOpen) {
      setIsChecked(false);

      // If the parent supplied limit info, use it; otherwise fetch it.
      if (externalStakeLimitInfo !== undefined) {
        setStakeLimitInfo(externalStakeLimitInfo ?? null);
      } else {
        setStakeLimitLoading(true);
        setStakeLimitError(null);

        fetch('/api/users/me/stake-limit', {
          credentials: 'include',
        })
          .then(async (res) => {
            if (!res.ok) return; // not authenticated — skip enforcement
            const data = (await res.json()) as StakeLimitInfo;
            if (isMountedRef.current) setStakeLimitInfo(data);
          })
          .catch(() => {
            // Non-fatal: if the check fails the button remains enabled but we
            // show a warning. Server-side enforcement is the authoritative gate.
            if (isMountedRef.current) {
              setStakeLimitError('Could not verify stake limit. Server-side limits still apply.');
            }
          })
          .finally(() => {
            if (isMountedRef.current) setStakeLimitLoading(false);
          });
      }
    }

    return () => {
      isMountedRef.current = false;
    };
  }, [isOpen, externalStakeLimitInfo]);

  const wouldExceedLimit =
    stakeLimitInfo !== null &&
    requiredStake > stakeLimitInfo.remainingCapacity;

  const handleConfirm = async () => {
    if (!isChecked) return;
    if (wouldExceedLimit) return;
    setIsLoading(true);
    try {
      await onConfirm();
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  };

  const canConfirm = isChecked && !isLoading && !wouldExceedLimit && !stakeLimitLoading;

  return (
    <Modal isOpen={isOpen} onClose={onClose}>
      <div className="bg-white border-4 border-black text-black">
        {/* Header */}
        <div className="border-b-4 border-black px-6 md:px-8 py-6">
          <h1 className="text-3xl md:text-4xl font-black italic text-left tracking-tight">
            JOIN ARENA #{arenaId}
          </h1>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 border-b-4 border-black">
          <div className="border-b-4 md:border-b-0 md:border-r-4 border-black px-6 md:px-8 py-6">
            <p className="text-xs font-bold tracking-widest text-left text-gray-600 mb-2">
              REQUIRED STAKE
            </p>
            <p className="text-2xl md:text-3xl text-left font-black">{requiredStake} USDC</p>
          </div>

          <div className="px-6 md:px-8 py-6">
            <p className="text-xs text-left font-bold tracking-widest text-gray-600 mb-2">
              CURRENT PLAYERS
            </p>
            <p className="text-2xl md:text-3xl text-left font-black text-lime-400">
              {currentPlayers} / {maxPlayers}
            </p>
          </div>
        </div>

        {/* Yield Section */}
        <div className="border-b-4 border-black px-6 md:px-8 py-6 flex items-center justify-between">
          <div>
            <p className="text-xs font-bold text-left tracking-widest text-gray-600 mb-2">
              YIELD GENERATION
            </p>
            <p className="text-2xl md:text-3xl font-black">{yieldGeneration}% APY</p>
          </div>
          <div className={`bg-black px-3 py-2 ${arenaStatus === 'ACTIVE' ? 'text-lime-400' : 'text-red-500'}`}>
            <span className="text-xs font-black tracking-widest">
              ■ {arenaStatus}
            </span>
          </div>
        </div>

        {/* ── Responsible game limits banner (#1411) ───────────────────── */}
        {stakeLimitLoading && (
          <div className="border-b-4 border-black px-6 md:px-8 py-4 bg-gray-50">
            <p className="text-xs font-bold text-gray-500 tracking-widest">
              CHECKING STAKE LIMIT…
            </p>
          </div>
        )}

        {!stakeLimitLoading && stakeLimitInfo && (
          <div
            className={`border-b-4 border-black px-6 md:px-8 py-4 ${
              wouldExceedLimit ? 'bg-red-50' : 'bg-lime-50'
            }`}
            role="status"
            aria-live="polite"
          >
            <p className="text-xs font-bold tracking-widest text-gray-600 mb-1">
              ACTIVE STAKE LIMIT
            </p>
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold">
                {stakeLimitInfo.currentActiveStake.toFixed(2)} /{' '}
                {stakeLimitInfo.limit.toFixed(2)} USDC in active arenas
              </p>
              <span
                className={`text-xs font-black tracking-widest px-2 py-1 ${
                  wouldExceedLimit
                    ? 'bg-red-500 text-white'
                    : 'bg-lime-400 text-black'
                }`}
              >
                {wouldExceedLimit ? '■ OVER LIMIT' : '■ OK'}
              </span>
            </div>
            {wouldExceedLimit && (
              <p className="text-xs text-red-600 font-bold mt-2" role="alert">
                You cannot join: this stake of {requiredStake} USDC would exceed your{' '}
                {stakeLimitInfo.limit} USDC active stake limit. Resolve or wait for
                other arenas to complete before joining a new one.
              </p>
            )}
            {!wouldExceedLimit && (
              <p className="text-xs text-gray-500 mt-1">
                Remaining capacity: {stakeLimitInfo.remainingCapacity.toFixed(2)} USDC
              </p>
            )}
          </div>
        )}

        {!stakeLimitLoading && stakeLimitError && (
          <div className="border-b-4 border-black px-6 md:px-8 py-3 bg-yellow-50" role="alert">
            <p className="text-xs font-bold text-yellow-700">{stakeLimitError}</p>
          </div>
        )}

        {/* Agreement Checkbox */}
        <div className="px-6 md:px-8 py-6">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isChecked}
              onChange={(e) => setIsChecked(e.target.checked)}
              disabled={wouldExceedLimit}
              className="mt-1 w-6 h-6 border-2 border-black cursor-pointer accent-black disabled:cursor-not-allowed disabled:opacity-50"
            />
            <span className="text-md md:text-lg italic font-bold leading-tight">
              I UNDERSTAND THAT MINORITY WINS.
            </span>
          </label>
        </div>

        {/* Buttons */}
        <div className="space-y-4 p-6">
          <button
            onClick={handleConfirm}
            disabled={!canConfirm}
            aria-disabled={!canConfirm}
            className={`w-full border-3 border-black py-4 px-6 font-black text-lg italic tracking-wide transition-all ${
              canConfirm
                ? 'bg-lime-400 text-black hover:bg-lime-300 active:scale-95'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            {isLoading
              ? 'CONFIRMING...'
              : wouldExceedLimit
              ? 'STAKE LIMIT EXCEEDED'
              : 'CONFIRM ENTRY'}
          </button>

          <button
            onClick={onClose}
            className="w-full border-3 border-black bg-white py-4 px-6 font-black text-lg tracking-wide hover:bg-gray-50 active:scale-95 transition-all"
          >
            CANCEL
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default JoinArenaModal;

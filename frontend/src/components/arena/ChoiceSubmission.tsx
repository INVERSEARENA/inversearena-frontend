"use client";

import { useEffect, useMemo, useState } from "react";
import { buildSubmitChoiceTransaction, submitSignedTransaction } from "@/shared-d/utils/stellar-transactions";
import type { WalletHook } from "@/features/wallet/useStellarWallet";

type Choice = "Heads" | "Tails";

interface ChoiceSubmissionProps {
  arenaId: string;
  roundNumber: number;
  deadline: string;
  arenaStatus: string;
  wallet: Pick<
    WalletHook,
    "publicKey" | "isConnected" | "connectWallet" | "signTransaction" | "status"
  >;
}

type SubmissionPhase = "idle" | "signing" | "submitting" | "submitted" | "error";

function formatRemaining(seconds: number): string {
  if (seconds <= 0) return "00:00";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function choiceStyles(choice: Choice, selected: Choice | null): string {
  const active = selected === choice;
  const base =
    "flex min-h-32 flex-1 flex-col justify-between border-4 px-5 py-6 text-left transition duration-200";
  if (choice === "Heads") {
    return `${base} ${
      active
        ? "border-[#3CFF1A] bg-[#07140b] shadow-[0_0_0_1px_#3CFF1A,0_0_24px_rgba(60,255,26,0.18)]"
        : "border-white/10 bg-[#08101a] hover:border-[#3CFF1A]/60 hover:bg-[#0b1724]"
    }`;
  }

  return `${base} ${
    active
      ? "border-[#FF0A54] bg-[#16070d] shadow-[0_0_0_1px_#FF0A54,0_0_24px_rgba(255,10,84,0.18)]"
      : "border-white/10 bg-[#08101a] hover:border-[#FF0A54]/60 hover:bg-[#0b1724]"
  }`;
}

export function ChoiceSubmission({
  arenaId,
  roundNumber,
  deadline,
  arenaStatus,
  wallet,
}: ChoiceSubmissionProps) {
  const { publicKey, isConnected, connectWallet, signTransaction, status: walletStatus } = wallet;
  const [selectedChoice, setSelectedChoice] = useState<Choice | null>(null);
  const [phase, setPhase] = useState<SubmissionPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState(0);

  const deadlineMs = useMemo(() => Date.parse(deadline), [deadline]);
  const isDeadlineReached = secondsRemaining <= 0;
  const isArenaOpen = arenaStatus.toUpperCase() === "OPEN";
  const isLocked = phase === "signing" || phase === "submitting" || phase === "submitted";

  useEffect(() => {
    const tick = () => {
      if (Number.isNaN(deadlineMs)) {
        setSecondsRemaining(0);
        return;
      }

      const delta = Math.max(0, Math.floor((deadlineMs - Date.now()) / 1000));
      setSecondsRemaining(delta);
    };

    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [deadlineMs]);

  const handleSubmit = async (choice: Choice) => {
    if (!isArenaOpen || isDeadlineReached || isLocked) return;

    setSelectedChoice(choice);
    setPhase("signing");
    setError(null);

    try {
      const address = publicKey ?? (await connectWallet());
      if (!address) {
        throw new Error("Connect a wallet before submitting your choice.");
      }

      const unsignedTx = await buildSubmitChoiceTransaction(
        address,
        arenaId,
        choice,
        roundNumber,
      );

      setPhase("submitting");
      const signedTxXdr = await signTransaction(unsignedTx.toXDR());
      await submitSignedTransaction(signedTxXdr);
      setPhase("submitted");
    } catch (submissionError) {
      setPhase("error");
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "Failed to submit choice",
      );
    }
  };

  const canInteract = isArenaOpen && !isDeadlineReached && !isLocked;

  return (
    <section className="rounded-[28px] border border-white/10 bg-[#07111d] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.35)] sm:p-6">
      <div className="flex flex-col gap-3 border-b border-white/10 pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/45">
            Choice Submission
          </p>
          <h2 className="mt-1 text-2xl font-black uppercase tracking-tight text-white sm:text-3xl">
            Round {roundNumber}
          </h2>
        </div>

        <div className="rounded-full border border-white/10 bg-black/30 px-4 py-2 text-right">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/45">
            Submission deadline
          </p>
          <p className="font-mono text-xl font-semibold tabular-nums text-white">
            {formatRemaining(secondsRemaining)}
          </p>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <button
          type="button"
          onClick={() => void handleSubmit("Heads")}
          disabled={!canInteract}
          aria-label="Submit Heads choice"
          className={choiceStyles("Heads", selectedChoice)}
        >
          <span className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/40">
            Heads
          </span>
          <span className="text-4xl font-black uppercase tracking-tight text-white sm:text-5xl">
            HEADS
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#3CFF1A]">
            Higher risk, lower crowd
          </span>
        </button>

        <button
          type="button"
          onClick={() => void handleSubmit("Tails")}
          disabled={!canInteract}
          aria-label="Submit Tails choice"
          className={choiceStyles("Tails", selectedChoice)}
        >
          <span className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/40">
            Tails
          </span>
          <span className="text-4xl font-black uppercase tracking-tight text-white sm:text-5xl">
            TAILS
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#FF0A54]">
            Safer path, tighter crowd
          </span>
        </button>
      </div>

      <div className="mt-4 flex flex-col gap-3 border-t border-white/10 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/45">
            Wallet status
          </p>
          <p className="text-sm text-white/80">
            {isConnected && publicKey
              ? `${publicKey.slice(0, 8)}...${publicKey.slice(-4)}`
              : walletStatus === "connecting"
                ? "Connecting wallet..."
                : "Wallet not connected"}
          </p>
        </div>

        <div className="text-right">
          {phase === "submitted" ? (
            <p className="text-sm font-semibold text-[#3CFF1A]">
              Choice submitted: {selectedChoice}
            </p>
          ) : phase === "error" ? (
            <div className="space-y-1">
              <p className="text-sm font-semibold text-[#FF0A54]">{error}</p>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setPhase("idle");
                }}
                className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/60 underline underline-offset-4"
              >
                Retry
              </button>
            </div>
          ) : (
            <p className="text-sm text-white/55">
              {isDeadlineReached
                ? "Submission window closed"
                : isArenaOpen
                  ? "Choose a side to lock in your round"
                  : "Arena is not open"}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

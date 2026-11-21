"use client";

/**
 * GiftSeatPanel — #1715 "Gift a seat" entry point for the arena lobby.
 *
 * The connected wallet is the payer: it funds the entry fee and owns any
 * refund. The recipient is the player: they own the seat and its prizes.
 * Recipient validation and the sponsored transaction live in `useJoinFlow`;
 * this component only renders the input, the policy explanation and the
 * confirmation modal so the ownership split is explicit before signing.
 */

import { TransactionModal } from "@/components/modals/TransactionModal";

import type { UseJoinFlowResult } from "../hooks/useJoinFlow";

export interface GiftSeatPanelProps {
  flow: UseJoinFlowResult;
  /** Connected payer wallet. Gifting is unavailable until one is connected. */
  payerWallet: string | null | undefined;
  entryFee: number;
  stakeToken: string;
  /** Lobby-level gate (closed round, already a player, etc.). */
  disabled?: boolean;
}

function formatEntryFee(entryFee: number, stakeToken: string): string {
  const formatted = entryFee.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(entryFee) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${formatted} ${stakeToken}`;
}

export function GiftSeatPanel({
  flow,
  payerWallet,
  entryFee,
  stakeToken,
  disabled = false,
}: GiftSeatPanelProps) {
  const payer = payerWallet ?? "Connect a wallet first";
  const recipient = flow.giftRecipient.trim();
  const fee = formatEntryFee(entryFee, stakeToken);
  const isDisabled = disabled || !payerWallet;

  return (
    <div className="rounded-[28px] border border-[#3CFF1A]/20 bg-[#08101b]/95 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.35)] sm:p-6">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#c8ffd1]">
        Gift a seat
      </p>
      <p className="mt-2 text-sm leading-6 text-white/60">
        Pay the entry fee for someone else. They join as the player; if the
        arena is cancelled, your fee is refunded to you.
      </p>

      <label
        htmlFor="gift-recipient"
        className="mt-4 block text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40"
      >
        Recipient address
      </label>
      <input
        id="gift-recipient"
        type="text"
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        value={flow.giftRecipient}
        onChange={(event) => flow.setGiftRecipient(event.target.value)}
        placeholder="G…"
        aria-invalid={Boolean(flow.giftError)}
        aria-describedby={flow.giftError ? "gift-recipient-error" : "gift-recipient-help"}
        className="mt-2 w-full rounded-2xl border border-white/15 bg-black/40 px-4 py-3 font-mono text-xs text-white outline-none transition placeholder:text-white/25 focus:border-[#3CFF1A]/60"
      />
      <p id="gift-recipient-help" className="mt-2 text-xs text-white/45">
        Stellar account address of the player receiving the seat.
      </p>
      {flow.giftError ? (
        <p
          id="gift-recipient-error"
          role="alert"
          className="mt-2 rounded-xl border border-red-500/30 bg-red-950/40 px-3 py-2 text-xs text-red-300"
        >
          {flow.giftError}
        </p>
      ) : null}

      <button
        type="button"
        disabled={isDisabled || flow.isReserving}
        onClick={() => void flow.openGiftModal()}
        className="mt-4 w-full rounded-full border border-[#3CFF1A]/40 bg-[#3CFF1A]/10 px-6 py-3 text-sm font-black uppercase tracking-[0.2em] text-[#c8ffd1] transition hover:bg-[#3CFF1A]/20 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/5 disabled:text-white/40"
      >
        {flow.isReserving ? "Reserving..." : "Gift a seat"}
      </button>

      <TransactionModal
        isOpen={flow.showGiftModal}
        onClose={flow.closeGiftModal}
        title="Gift a seat"
        description="You fund the entry fee. The recipient owns the seat, any prizes, and gives consent by signing too."
        details={[
          { label: "Payer", value: payer, isImportant: true },
          { label: "Recipient", value: recipient || "—", isImportant: true },
          { label: "Entry fee", value: fee },
          { label: "Refund destination", value: payer, isImportant: true },
          { label: "Prize recipient", value: recipient || "—", isImportant: true },
        ]}
        confirmLabel="Sign & Gift"
        onConfirm={flow.handleConfirmGift}
      />
    </div>
  );
}

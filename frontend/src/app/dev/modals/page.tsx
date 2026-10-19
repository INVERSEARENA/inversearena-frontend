"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";

const ROW = "flex items-start gap-3 rounded-lg border border-white/10 p-4";

/**
 * Modal gallery (#1645). Renders the shared Modal chrome in closed, open, and
 * warning states with the copy each real modal uses. The live modals
 * (JoinArenaModal, StakeModal, PoolCreationModal) pull wallet + contract
 * hooks, so their *chrome* is storyed here with mocked content instead.
 */
export default function ModalsGallery() {
  const [open, setOpen] = useState(true);

  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-3 text-lg font-semibold">Modal chrome</h2>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded-lg bg-[#63b3ed] px-4 py-2 font-semibold text-[#080b14]"
        >
          {open ? "Close demo modal" : "Open demo modal"}
        </button>

        <Modal isOpen={open} onClose={() => setOpen(false)} ariaLabel="Join arena">
          <div className="space-y-3">
            <h3 className="text-lg font-semibold">Join arena</h3>
            <p className={ROW}>
              <span className="text-[#63b3ed]">1.</span>
              Commit to Heads or Tails. Your choice is hidden until the round
              resolves — the minority side wins.
            </p>
            <p className={ROW}>
              <span className="text-[#63b3ed]">2.</span>
              Required stake <strong>500 XLM</strong> · 72 / 100 players seated.
            </p>
            <label className="flex items-center gap-2 text-sm text-white/70">
              <input type="checkbox" /> I understand that the minority choice wins.
            </label>
          </div>
        </Modal>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Modal copy states</h2>
        <div className="space-y-3">
          <div className={ROW}>
            <strong className="text-[#63b3ed]">Join</strong>
            <span className="text-white/70">
              Eligibility check → agreement checkbox → build/sign/submit via
              useTransactionFlow.
            </span>
          </div>
          <div className={ROW}>
            <strong className="text-[#63b3ed]">Stake</strong>
            <span className="text-white/70">
              Amount entry → asset readiness gate → protocol stake transaction.
            </span>
          </div>
          <div className={ROW}>
            <strong className="text-[#63b3ed]">Pool success</strong>
            <span className="text-white/70">
              Success callout with share affordances after a pool fills.
            </span>
          </div>
          <div className={ROW}>
            <strong className="text-[#63b3ed]">Share</strong>
            <span className="text-white/70">
              Social-card preview + copy-link / QR actions.
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}

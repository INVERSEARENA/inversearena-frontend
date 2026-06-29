"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@/features/wallet/useWallet";
import { PoolCreationModal } from "@/components/modals/PoolCreationModal";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ArenaEntry {
  id: string;
  name: string;
  state: "open" | "active" | "finished" | "cancelled";
  playerCount: number;
  maxPlayers: number;
  currentRound: number;
}

interface PayoutRow {
  arenaId: string;
  recipient: string;
  amount: number;
  currency: string;
  status: "queued" | "submitted" | "confirmed" | "failed";
  txHash?: string;
}

// ---------------------------------------------------------------------------
// Mock helpers — replace with real API calls
// ---------------------------------------------------------------------------

async function fetchAdminArenas(adminAddress: string): Promise<ArenaEntry[]> {
  void adminAddress;
  await new Promise((r) => setTimeout(r, 400));
  return [
    { id: "ARENA-001", name: "Alpha Arena", state: "active", playerCount: 64, maxPlayers: 128, currentRound: 3 },
    { id: "ARENA-002", name: "Beta Arena", state: "open", playerCount: 12, maxPlayers: 64, currentRound: 0 },
    { id: "ARENA-003", name: "Gamma Arena", state: "finished", playerCount: 256, maxPlayers: 256, currentRound: 8 },
  ];
}

async function fetchPayoutStatus(): Promise<PayoutRow[]> {
  await new Promise((r) => setTimeout(r, 400));
  return [
    { arenaId: "ARENA-001", recipient: "GDRXE2BQ...S7SB", amount: 12_800, currency: "XLM", status: "submitted", txHash: "0x7a3f...8b2c" },
    { arenaId: "ARENA-003", recipient: "GAAZI4TC...LHXK", amount: 64_000, currency: "XLM", status: "confirmed", txHash: "0x91cc...3df1" },
    { arenaId: "ARENA-002", recipient: "", amount: 3_200, currency: "XLM", status: "queued" },
  ];
}

async function resolveRound(arenaId: string): Promise<void> {
  void arenaId;
  await new Promise((r) => setTimeout(r, 800));
}

async function closeRound(arenaId: string): Promise<void> {
  void arenaId;
  await new Promise((r) => setTimeout(r, 800));
}

async function cancelArena(arenaId: string): Promise<void> {
  void arenaId;
  await new Promise((r) => setTimeout(r, 800));
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StateBadge({ state }: { state: ArenaEntry["state"] }) {
  const colours: Record<ArenaEntry["state"], string> = {
    open: "border-blue-400 text-blue-400",
    active: "border-neon-green text-neon-green",
    finished: "border-white/30 text-white/40",
    cancelled: "border-neon-pink text-neon-pink",
  };
  return (
    <span className={`font-pixel text-[8px] border px-2 py-0.5 tracking-wider uppercase ${colours[state]}`}>
      {state}
    </span>
  );
}

function PayoutBadge({ status }: { status: PayoutRow["status"] }) {
  const colours: Record<PayoutRow["status"], string> = {
    queued: "bg-white/10 text-white/60",
    submitted: "bg-blue-500/20 text-blue-300",
    confirmed: "bg-neon-green/20 text-neon-green",
    failed: "bg-neon-pink/20 text-neon-pink",
  };
  return (
    <span className={`font-pixel text-[8px] px-2 py-0.5 tracking-wider uppercase ${colours[status]}`}>
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminDashboardPage() {
  const router = useRouter();
  const { status, publicKey } = useWallet();

  const [arenas, setArenas] = useState<ArenaEntry[]>([]);
  const [payouts, setPayouts] = useState<PayoutRow[]>([]);
  const [loadingArenas, setLoadingArenas] = useState(true);
  const [loadingPayouts, setLoadingPayouts] = useState(true);
  const [actionState, setActionState] = useState<Record<string, boolean>>({});
  const [confirmDialog, setConfirmDialog] = useState<{
    arenaId: string;
    action: "resolve" | "close" | "cancel";
  } | null>(null);
  const [isPoolModalOpen, setIsPoolModalOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Redirect unauthenticated users
  useEffect(() => {
    if (status === "disconnected") {
      router.replace("/");
    }
  }, [status, router]);

  const loadArenas = useCallback(async () => {
    if (!publicKey) return;
    setLoadingArenas(true);
    try {
      const data = await fetchAdminArenas(publicKey);
      setArenas(data);
    } finally {
      setLoadingArenas(false);
    }
  }, [publicKey]);

  const loadPayouts = useCallback(async () => {
    setLoadingPayouts(true);
    try {
      const data = await fetchPayoutStatus();
      setPayouts(data);
    } finally {
      setLoadingPayouts(false);
    }
  }, []);

  useEffect(() => {
    loadArenas();
  }, [loadArenas]);

  // Refresh payout table every 15 seconds
  useEffect(() => {
    loadPayouts();
    const id = setInterval(loadPayouts, 15_000);
    return () => clearInterval(id);
  }, [loadPayouts]);

  const setArenaAction = (arenaId: string, loading: boolean) =>
    setActionState((prev) => ({ ...prev, [arenaId]: loading }));

  const handleConfirmedAction = async () => {
    if (!confirmDialog) return;
    const { arenaId, action } = confirmDialog;
    setConfirmDialog(null);
    setActionError(null);
    setArenaAction(arenaId, true);
    try {
      if (action === "resolve") await resolveRound(arenaId);
      else if (action === "close") await closeRound(arenaId);
      else if (action === "cancel") await cancelArena(arenaId);
      await loadArenas();
    } catch {
      setActionError(`Failed to ${action} arena ${arenaId}. Please try again.`);
    } finally {
      setArenaAction(arenaId, false);
    }
  };

  if (status === "connecting" || status === "disconnected") {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <p className="font-pixel text-neon-green text-sm animate-pulse tracking-widest">
          {status === "connecting" ? "CONNECTING..." : "REDIRECTING..."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-pixel text-lg text-white tracking-wider">ADMIN DASHBOARD</h1>
          <p className="font-mono text-xs text-white/40 mt-1">
            {publicKey ? `${publicKey.slice(0, 8)}...${publicKey.slice(-6)}` : "—"}
          </p>
        </div>
        <button
          onClick={() => setIsPoolModalOpen(true)}
          className="bg-neon-green text-black font-pixel text-[9px] px-5 py-2 hover:opacity-90 uppercase tracking-widest"
        >
          + CREATE ARENA
        </button>
      </div>

      {/* Error banner */}
      {actionError && (
        <div className="border border-neon-pink bg-neon-pink/10 p-4 flex justify-between items-center">
          <p className="font-pixel text-[9px] text-neon-pink tracking-wider">{actionError}</p>
          <button
            onClick={() => setActionError(null)}
            className="font-pixel text-[8px] text-neon-pink hover:opacity-70 ml-4"
          >
            ✕
          </button>
        </div>
      )}

      {/* My Arenas */}
      <section className="space-y-3">
        <h2 className="font-pixel text-[10px] text-white/60 tracking-widest uppercase">
          MY ARENAS
        </h2>

        {loadingArenas ? (
          <div className="border border-white/10 p-6 text-center">
            <p className="font-pixel text-[9px] text-white/40 animate-pulse">LOADING ARENAS...</p>
          </div>
        ) : arenas.length === 0 ? (
          <div className="border border-white/10 p-6 text-center">
            <p className="font-pixel text-[9px] text-white/40">NO ARENAS FOUND FOR THIS WALLET</p>
          </div>
        ) : (
          <div className="space-y-2">
            {arenas.map((arena) => {
              const busy = actionState[arena.id];
              const canAct = arena.state === "active" || arena.state === "open";
              return (
                <div
                  key={arena.id}
                  className="border border-white/10 p-4 flex flex-col md:flex-row md:items-center justify-between gap-3"
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="font-pixel text-xs text-white">{arena.name}</span>
                      <StateBadge state={arena.state} />
                    </div>
                    <p className="font-mono text-[10px] text-white/40">
                      ID: {arena.id} &nbsp;·&nbsp; Players: {arena.playerCount}/{arena.maxPlayers}
                      {arena.state === "active" && ` · Round ${arena.currentRound}`}
                    </p>
                  </div>

                  {/* Round controls */}
                  {canAct && (
                    <div className="flex gap-2 flex-shrink-0 flex-wrap">
                      {arena.state === "active" && (
                        <>
                          <button
                            disabled={busy}
                            onClick={() => setConfirmDialog({ arenaId: arena.id, action: "close" })}
                            className="border border-white/20 text-white font-pixel text-[8px] px-3 py-1.5 hover:bg-white/5 disabled:opacity-40 uppercase tracking-wider"
                          >
                            {busy ? "..." : "CLOSE ROUND"}
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => setConfirmDialog({ arenaId: arena.id, action: "resolve" })}
                            className="bg-neon-green text-black font-pixel text-[8px] px-3 py-1.5 hover:opacity-90 disabled:opacity-40 uppercase tracking-wider"
                          >
                            {busy ? "..." : "RESOLVE ROUND"}
                          </button>
                        </>
                      )}
                      {/* Cancel — only before game starts (state === 'open') */}
                      {arena.state === "open" && (
                        <button
                          disabled={busy}
                          onClick={() => setConfirmDialog({ arenaId: arena.id, action: "cancel" })}
                          className="border border-neon-pink text-neon-pink font-pixel text-[8px] px-3 py-1.5 hover:bg-neon-pink/10 disabled:opacity-40 uppercase tracking-wider"
                        >
                          {busy ? "..." : "CANCEL ARENA"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Payout Status */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-pixel text-[10px] text-white/60 tracking-widest uppercase">
            PAYOUT STATUS
          </h2>
          <span className="font-mono text-[9px] text-white/30">auto-refreshes every 15s</span>
        </div>

        {loadingPayouts ? (
          <div className="border border-white/10 p-6 text-center">
            <p className="font-pixel text-[9px] text-white/40 animate-pulse">LOADING PAYOUTS...</p>
          </div>
        ) : (
          <div className="border border-white/10 overflow-x-auto">
            <table className="w-full text-left min-w-[560px]">
              <thead>
                <tr className="border-b border-white/10">
                  {["ARENA", "RECIPIENT", "AMOUNT", "STATUS", "TX HASH"].map((h) => (
                    <th key={h} className="font-pixel text-[8px] text-white/40 px-4 py-3 tracking-wider">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {payouts.map((row, i) => (
                  <tr key={i} className="border-b border-white/5 hover:bg-white/2">
                    <td className="font-mono text-xs text-white/70 px-4 py-3">{row.arenaId}</td>
                    <td className="font-mono text-xs text-white/70 px-4 py-3 max-w-[120px] truncate">
                      {row.recipient || "—"}
                    </td>
                    <td className="font-pixel text-[9px] text-neon-green px-4 py-3">
                      {row.amount.toLocaleString()} {row.currency}
                    </td>
                    <td className="px-4 py-3">
                      <PayoutBadge status={row.status} />
                    </td>
                    <td className="font-mono text-[10px] text-white/40 px-4 py-3">
                      {row.txHash ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Confirm dialog */}
      {confirmDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-black border border-white/20 p-6 max-w-sm w-full space-y-4">
            <h3 className="font-pixel text-sm text-white uppercase tracking-wider">
              CONFIRM:{" "}
              {confirmDialog.action === "resolve"
                ? "RESOLVE ROUND"
                : confirmDialog.action === "close"
                ? "CLOSE ROUND"
                : "CANCEL ARENA"}
            </h3>
            <p className="font-mono text-xs text-white/60">
              {confirmDialog.action === "cancel"
                ? `This will cancel arena ${confirmDialog.arenaId} and trigger full refunds to all joined players. This cannot be undone.`
                : `This will ${confirmDialog.action} the current round for arena ${confirmDialog.arenaId}.`}
            </p>
            <div className="flex gap-3 pt-2">
              <button
                onClick={handleConfirmedAction}
                className={`flex-1 font-pixel text-[9px] py-2 uppercase tracking-wider ${
                  confirmDialog.action === "cancel"
                    ? "bg-neon-pink text-white hover:opacity-90"
                    : "bg-neon-green text-black hover:opacity-90"
                }`}
              >
                CONFIRM
              </button>
              <button
                onClick={() => setConfirmDialog(null)}
                className="flex-1 border border-white/20 text-white font-pixel text-[9px] py-2 hover:bg-white/5 uppercase tracking-wider"
              >
                CANCEL
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Arena shortcut modal */}
      <PoolCreationModal
        isOpen={isPoolModalOpen}
        onClose={() => setIsPoolModalOpen(false)}
        onInitialize={() => {
          setIsPoolModalOpen(false);
          loadArenas();
        }}
      />
    </div>
  );
}

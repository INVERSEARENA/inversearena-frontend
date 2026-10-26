"use client";

/**
 * ArenaLobbyClient — thin orchestrator for the arena lobby page (#1604).
 * Data: useLobbyData. Flow: useJoinFlow. UI: LobbyHeader / PlayerRoster / JoinPanel.
 */

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { ArenaStatsSkeleton } from "@/components/arena/ArenaStatsSkeleton";
import { ChoiceSubmission } from "@/components/arena/ChoiceSubmission";
import { TransactionModal, type TransactionProgress } from "@/components/modals/TransactionModal";
import { useWallet } from "@/features/wallet";
import {
  buildJoinArenaTransaction,
  buildLeaveArenaTransaction,
  submitSignedTransaction,
  NETWORK_PASSPHRASE,
} from "@/shared/lib/stellar/stellar-transactions";
import {
  evaluateSigningRequest,
  // Imported as a value, not a type: these call sites narrow policy
  // rejections with `instanceof SigningPolicyError`, which a type-only import
  // erases to `any` and silently turns into a dead branch.
  SigningPolicyError,
  type DecodedEnvelope,
} from "@/shared/lib/security/policy";
import { useAssetReadinessGate } from "@/features/asset-readiness";
import { useRegistryLifecycle } from "@/features/pools/model/useRegistryLifecycle";
import { playerLifecycleNotice } from "@/shared/lib/stellar/registry-lifecycle";
import { stellarConfig } from "@/shared/config/stellarConfig";
import { displayAmountToStroops } from "@/shared/lib/stellar/stellar-asset-reader";
import { AssetTrustlinePrompt } from "@/components/modals/AssetTrustlinePrompt";
import { useWallet } from "@/features/wallet";
import { useLobbyData, type ArenaStats, type ArenaParticipant } from "../hooks/useLobbyData";
import { useJoinFlow } from "../hooks/useJoinFlow";
import { LobbyHeader } from "./LobbyHeader";
import { PlayerRoster } from "./PlayerRoster";
import { JoinPanel } from "./JoinPanel";

interface ArenaLobbyClientProps {
  arenaId: string;
  initialStats: ArenaStats | null;
  initialParticipants: ArenaParticipant[];
  initialNextCursor: number | null;
  notFound?: boolean;
}

export function ArenaLobbyClient({ arenaId, initialStats, initialParticipants, initialNextCursor, notFound = false }: ArenaLobbyClientProps) {
  const router = useRouter();
  const wallet = useWallet();
  const lobby = useLobbyData({ arenaId, initialStats, initialParticipants, initialNextCursor, notFound });
  const isParticipant = useMemo(() => Boolean(wallet.publicKey && lobby.participants.some((p) => p.walletAddress === wallet.publicKey)), [lobby.participants, wallet.publicKey]);
  const walletConnected = wallet.isConnected && !!wallet.publicKey;
  const canLeave = lobby.stats?.status === "open" && lobby.stats.currentRound === 0 && isParticipant && walletConnected && !lobby.loadingStats;

  const flow = useJoinFlow({
    arenaId, stats: lobby.stats,
    wallet: { publicKey: wallet.publicKey, isConnected: wallet.isConnected, signTransaction: wallet.signTransaction },
    onJoinSuccess: async () => {
      await Promise.all([lobby.fetchStats(), lobby.fetchParticipants(0, true)]);
      document.getElementById("choice-submission")?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    onLeaveSuccess: async () => { await Promise.all([lobby.fetchStats(), lobby.fetchParticipants(0, true)]); },
  });

  if (notFound) return (
    <div className="min-h-screen bg-[#050816] px-4 py-10 text-white sm:px-6 lg:px-8">
      <div className="mx-auto flex min-h-[70vh] w-full max-w-4xl flex-col justify-center rounded-[28px] border border-white/10 bg-[#08101b] p-8 text-center">
        <h1 className="text-4xl font-black uppercase">No lobby for {arenaId}</h1>
        <button type="button" onClick={() => router.push("/dashboard/games")} className="mx-auto mt-8 rounded-full border border-white/10 bg-white px-6 py-3 text-sm font-semibold uppercase text-black">Back to Games</button>
      </div>
    </div>
  );

  if (!lobby.stats) return (
    <div className="min-h-screen bg-[#050816] px-4 py-10 text-white"><div className="mx-auto w-full max-w-7xl"><ArenaStatsSkeleton /></div></div>
  );

  // #1688: a deprecated integration never blocks an existing arena. The
  // notice explains that the arena still settles and that the deprecation
  // only applies to new arenas — it is deliberately not an "unsupported"
  // label, which would read as "your claims are gone".
  const registryLifecycle = useRegistryLifecycle({
    enabled: true,
    vault: stellarConfig.rwaVaultContractId,
    oracle: stellarConfig.oracleContractId,
  });
  const lifecycleNotice = playerLifecycleNotice(registryLifecycle, {
    vault: stellarConfig.rwaVaultContractId,
    oracle: stellarConfig.oracleContractId,
  });

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(60,255,26,0.14),_transparent_36%),linear-gradient(180deg,_#050816_0%,_#07111d_42%,_#050816_100%)] px-4 py-6 text-white sm:px-6 lg:px-8">
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <section className="rounded-[32px] border border-white/10 bg-[#08101b]/95 p-6 shadow-[0_30px_100px_rgba(0,0,0,0.4)] backdrop-blur sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-4">
              <div className="inline-flex items-center gap-2 rounded-full border border-[#3CFF1A]/30 bg-[#07140b] px-3 py-1">
                <span className="h-2.5 w-2.5 rounded-full bg-[#3CFF1A] shadow-[0_0_18px_rgba(60,255,26,0.85)]" />
                <span className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[#c8ffd1]">
                  {stats.status.toUpperCase()} / Round {stats.currentRound}
                </span>
              </div>
              {lifecycleNotice && (
                <div
                  role="status"
                  className="inline-flex items-center gap-2 rounded-full border border-amber-400/40 bg-amber-950/60 px-3 py-1"
                >
                  <span className="h-2 w-2 rounded-full bg-amber-400" />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-amber-200">
                    Deprecated integration
                  </span>
                </div>
              )}
              {stats.degraded && (
                <div
                  role="status"
                  className="inline-flex items-center gap-2 rounded-full border border-amber-400/40 bg-amber-950/60 px-3 py-1"
                >
                  <span className="h-2 w-2 rounded-full bg-amber-400" />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-amber-200">
                    Delayed data{stats.ledgerSequence != null ? ` — as of ledger ${stats.ledgerSequence}` : ""}
                  </span>
                </div>
              )}
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-white/45">
                  Arena Lobby
                </p>
                <h1 className="mt-2 text-4xl font-black uppercase tracking-tight sm:text-5xl lg:text-6xl">
                  {stats.arenaName}
                </h1>
                <p className="mt-3 max-w-3xl text-sm leading-7 text-white/70 sm:text-base">
                  Live lobby for <span className="font-mono text-white">{arenaId}</span>. Track the player count, accumulated yield, and the countdown to the join deadline before you lock in your choice.
                </p>
                {lifecycleNotice && (
                  <p className="mt-3 max-w-3xl rounded-2xl border border-amber-400/30 bg-amber-950/30 px-4 py-3 text-sm leading-6 text-amber-100">
                    {lifecycleNotice}
                  </p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:min-w-[560px]">
              <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
                  Player Count
                </p>
                <p className="mt-2 text-2xl font-black tabular-nums">
                  {playerCapacity}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
                  Current Pot
                </p>
                <p className="mt-2 text-2xl font-black tabular-nums">
                  {formatCurrency(stats.currentPot, stats.stakeToken)}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
                  Accrued Yield
                </p>
                <p className="mt-2 text-2xl font-black tabular-nums text-[#3CFF1A]">
                  +{formatCurrency(stats.yieldAccrued, stats.stakeToken)}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
                  Join Countdown
                </p>
                <p className="mt-2 text-2xl font-black tabular-nums">
                  {formatCountdown(stats.joinDeadline)}
                </p>
              </div>
            </div>
          </div>

          <div className="mt-6 flex flex-col gap-3 border-t border-white/10 pt-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-white/40">
                Lobby state
              </p>
              <p className="text-sm text-white/70">
                {isOpen
                  ? "Open for joins and active choice submission"
                  : "Lobby is closed to new entries"}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {canLeave && (
                <button
                  type="button"
                  onClick={() => setShowLeaveModal(true)}
                  className="rounded-full border border-white/20 bg-white/5 px-6 py-3 text-sm font-black uppercase tracking-[0.2em] text-white/70 transition hover:border-red-400/50 hover:text-red-300"
                >
                  Leave Arena
                </button>
              )}
              <button
                type="button"
                disabled={joinDisabled || isReserving}
                onClick={() => void handleJoinClick()}
                className="rounded-full border border-[#3CFF1A]/40 bg-[#3CFF1A] px-6 py-3 text-sm font-black uppercase tracking-[0.2em] text-black transition hover:brightness-95 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/10 disabled:text-white/40"
              >
                {isReserving ? "Reserving..." : joinLabel}
              </button>
            </div>
          </div>
          {reservationError && (
            <p role="alert" className="mt-3 text-sm font-semibold text-red-400">
              {reservationError}
            </p>
          )}
          {assetGate.phase !== "ready" && assetGate.phase !== "idle" && (
            <div className="mt-3 rounded-2xl border border-white/10 bg-black/30 p-4 text-sm text-white/70">
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
                Asset readiness
              </p>
              <p className="mt-2 text-left">{assetGate.message}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {assetGate.phase === "remediation_offered" && (
                  <button
                    type="button"
                    onClick={() => setShowTrustline(true)}
                    className="rounded-full border border-white/20 px-4 py-2 text-xs font-black uppercase tracking-[0.16em] text-white"
                  >
                    Set up trustline
                  </button>
                )}
                {assetGate.canRetry && (
                  <button
                    type="button"
                    onClick={() => void assetGate.check()}
                    className="rounded-full border border-white/20 px-4 py-2 text-xs font-black uppercase tracking-[0.16em] text-white/70"
                  >
                    Check again
                  </button>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
          <PlayerRoster participants={lobby.participants} hasMore={lobby.hasMore} loadingParticipants={lobby.loadingParticipants}
            nextCursor={lobby.nextCursor} onLoadMore={(c) => void lobby.fetchParticipants(c, false)} />
          <div className="space-y-6">
            <div id="choice-submission">
              <ChoiceSubmission arenaId={arenaId} roundNumber={s.currentRound} deadline={s.joinDeadline ?? ""} arenaStatus={s.status}
                wallet={{ publicKey: wallet.publicKey, isConnected: wallet.isConnected, status: wallet.status, signTransaction: wallet.signTransaction,
                  connectWallet: async () => { const a = await wallet.connect(); if (!a) throw new Error("No address"); return a; } }} />
            </div>
            <JoinPanel survivorCount={s.survivorCount} entryFee={s.entryFee} stakeToken={s.stakeToken} error={lobby.error} />
          </div>
        </section>
      </main>

      <TransactionModal isOpen={flow.showJoinModal} onClose={flow.handleCloseJoinModal} title="Join Arena" description="Confirm your entry"
        details={[{ label: "Arena", value: s.arenaName }, { label: "Entry Fee", value: `${s.entryFee} ${s.stakeToken}` }]}
        confirmLabel="Sign & Join" onConfirm={flow.handleConfirmJoin} />
      <TransactionModal isOpen={flow.showLeaveModal} onClose={flow.closeLeaveModal} title="Leave Arena" description="Reclaim your entry fee."
        details={[{ label: "Arena", value: s.arenaName }, { label: "Refund", value: `${s.entryFee} ${s.stakeToken}` }]}
        confirmLabel="Sign & Leave" onConfirm={flow.handleConfirmLeave} />
      {(flow.joinError ?? flow.leaveError) && (
        <div className="mt-3 rounded-2xl border border-red-500/30 bg-red-900/60 p-4 text-sm text-red-300">
          <p className="font-semibold uppercase tracking-[0.2em]">{flow.joinError ?? flow.leaveError}</p>
        </div>
      )}
      <AssetTrustlinePrompt isOpen={flow.showTrustline} onClose={() => flow.setShowTrustline(false)}
        remediation={flow.assetGate.remediation} message={flow.assetGate.message}
        phase={flow.assetGate.phase === "remediating" ? "remediating" : flow.assetGate.phase === "blocked" ? "blocked" : "remediation_offered"}
        onConfirm={async () => { await flow.assetGate.remediate(); if (flow.assetGate.canProceed) flow.setShowTrustline(false); }}
        onRetry={() => void flow.assetGate.check()} actionLabel="join this arena" />
    </div>
  );
}

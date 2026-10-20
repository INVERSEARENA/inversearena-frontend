"use client";

/**
 * ArenaLobbyClient — thin orchestrator for the arena lobby page (#1604).
 * Data: useLobbyData. Flow: useJoinFlow. UI: LobbyHeader / PlayerRoster / JoinPanel.
 */

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { ArenaStatsSkeleton } from "@/components/arena/ArenaStatsSkeleton";
import { ChoiceSubmission } from "@/components/arena/ChoiceSubmission";
import { TransactionModal } from "@/components/modals/TransactionModal";
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

  const s = lobby.stats;
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(60,255,26,0.14),_transparent_36%),linear-gradient(180deg,_#050816_0%,_#07111d_42%,_#050816_100%)] px-4 py-6 text-white sm:px-6 lg:px-8">
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <LobbyHeader arenaId={arenaId} stats={s} walletConnected={walletConnected} isParticipant={isParticipant} canLeave={canLeave ?? false}
          loadingStats={lobby.loadingStats} isReserving={flow.isReserving} reservationError={flow.reservationError}
          assetGatePhase={flow.assetGate.phase} assetGateMessage={flow.assetGate.message} assetGateCanRetry={flow.assetGate.canRetry}
          onJoinClick={() => void flow.handleJoinClick()} onLeaveClick={flow.openLeaveModal}
          onSetupTrustline={() => flow.setShowTrustline(true)} onRetryAssetCheck={() => void flow.assetGate.check()} />

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

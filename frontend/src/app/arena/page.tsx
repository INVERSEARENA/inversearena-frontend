"use client";

import dynamic from "next/dynamic";
import { useEffect, useCallback, useState } from "react";
import { ErrorBoundary } from "@/components/error-boundary/ErrorBoundary";
import { ErrorFallback } from "@/components/error-boundary/ErrorFallback";
import {
  Timer,
  ChoiceCard,
  TensionBar,
  ChooseYourFate,
  TotalYieldPot,
} from "@/components/arena/core";
import { useWallet } from "@/features/wallet/hooks/useWallet";
import { TransactionModal } from "@/components/modals/TransactionModal";
import { AssetTrustlinePrompt } from "@/components/modals/AssetTrustlinePrompt";
import { useAssetReadinessGate } from "@/features/asset-readiness/hooks/useAssetReadinessGate";
import { displayAmountToStroops } from "@/shared/lib/stellar/stellar-asset-reader";
import {
  evaluateSigningRequest,
  SigningPolicyError,
} from "@/shared/lib/security/policy";
import { ArenaStatsSkeleton } from "@/components/arena/ArenaStatsSkeleton";
import { ArenaStateSummary } from "@/components/arena/ArenaStateSummary";
import {
  buildJoinArenaTransaction,
  buildSubmitCommitmentTransaction,
  buildRevealChoiceTransaction,
  buildClaimWinningsTransaction,
  submitSignedTransaction,
  clearCommitmentForRound,
  hasStoredCommitmentForRound,
  captureTransactionOutcome,
  reconcileTransaction,
  type TransactionOutcome,
  NETWORK_PASSPHRASE,
} from "@/shared/lib/stellar/stellar-transactions";
import { useArenaStream } from "@/features/arena/hooks/useArenaStream";
import { useArenaState } from "@/features/arena/hooks/useArenaState";
import { useTransactionIntent, type IntentKind } from "@/shared/lib/hooks/useTransactionIntent";
import {
  useArenaReducer,
  canShowCommitButton,
  canShowRevealButton,
  canShowClaimButton,
} from "@/features/arena/hooks/useArenaReducer";
import type { Transaction } from "@stellar/stellar-sdk";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
const COMMIT_WINDOW_SECONDS = 60;
const REVEAL_WINDOW_SECONDS = 30;

const DEMO_ELIMINATION_FEED = [
  { id: "demo-1", label: "S-6782-5", roundNumber: 1, status: "OUT" as const, createdAt: "2026-05-29T00:00:00.000Z" },
  { id: "demo-2", label: "S-3382-8", roundNumber: 1, status: "OUT" as const, createdAt: "2026-05-29T00:00:00.000Z" },
  { id: "demo-3", label: "K-0001-A", roundNumber: 1, status: "OUT" as const, createdAt: "2026-05-29T00:00:00.000Z" },
  { id: "demo-4", label: "S-9921-W", roundNumber: 1, status: "ACTIVE" as const, createdAt: "2026-05-29T00:00:00.000Z" },
];

const RoundResolvedOverlay = dynamic(() => import("@/components/arena/core/RoundResolvedOverlay"), { ssr: false });
const EliminationSummaryOverlay = dynamic(
  () => import("@/components/arena/core/EliminationSummaryOverlay").then((m) => ({ default: m.EliminationSummaryOverlay })),
  { ssr: false },
);

export default function ArenaPage() {
  return (
    <ErrorBoundary fallback={<ErrorFallback context="arena" />}>
      <ArenaGameView />
    </ErrorBoundary>
  );
}

function ArenaGameView() {
  const { isConnected, address, connect, signTransaction, refreshBalance } = useWallet();
  const { runTrackedTransaction } = useTransactionIntent();

  // Phase-driven state machine (#1605) — replaces many interdependent useState calls.
  const { state, dispatch } = useArenaReducer();

  // Ancillary UI state not covered by the machine (modal and oracle display only).
  const [showTxModal, setShowTxModal] = useState(false);
  const [txType, setTxType] = useState<"JOIN" | "COMMIT" | "REVEAL" | "CLAIM" | null>(null);
  const [txDetails, setTxDetails] = useState<{ label: string; value: string | number }[]>([]);
  const [showTrustline, setShowTrustline] = useState(false);
  const [oracleYield, setOracleYield] = useState<number | null>(null);
  const [oracleFreshness, setOracleFreshness] = useState<"fresh" | "warning" | "stale" | "unavailable" | undefined>(undefined);
  const [oracleAgeSeconds, setOracleAgeSeconds] = useState<number | null>(null);
  const [isLoadingYield, setIsLoadingYield] = useState(true);

  const ARENA_ID = process.env.NEXT_PUBLIC_DEMO_ARENA_ID ?? "";
  const { playerStatus, actions: arenaActions, reconcile: reconcileArenaState } = useArenaState(ARENA_ID, address ?? undefined);
  const { status: streamStatus, snapshot, feed: streamFeed } = useArenaStream(ARENA_ID);

  const headsPercentage = 42;
  const tailsPercentage = 58;
  const headsYield = oracleYield ?? 42;
  const tailsYield = oracleYield ?? 58;

  const claimAssetGate = useAssetReadinessGate({
    assetCode: "USDC",
    amountStroops: (() => { try { return displayAmountToStroops(state.potentialPayout); } catch { return 0n; } })(),
    entryPoint: "claim",
    enabled: isConnected && state.hasWon && !!address,
  });

  // Fetch oracle yield.
  useEffect(() => {
    async function fetchYield() {
      try {
        const response = await fetch(`${API_BASE}/api/oracle/yield`);
        const data = await response.json();
        setOracleYield(data.currentAPY);
        setOracleFreshness(data.freshness);
        setOracleAgeSeconds(typeof data.ageSeconds === "number" ? data.ageSeconds : null);
      } catch (err) {
        console.error("Failed to fetch oracle yield", err);
      } finally {
        setIsLoadingYield(false);
      }
    }
    fetchYield();
  }, []);

  // Drive state machine from stream snapshot.
  useEffect(() => {
    if (!snapshot) return;
    dispatch({ type: "CHAIN_STATE_LOADED", payload: {
      isUserIn: state.isJoined,
      hasWon: snapshot.status === "settled" || snapshot.survivorCount <= 1,
      survivorsCount: snapshot.survivorCount,
      maxCapacity: snapshot.playerCount || state.survivors.max,
      currentStake: state.currentStake,
      potentialPayout: state.potentialPayout,
      entryFee: state.entryFee ?? 0,
      playerCount: snapshot.playerCount,
      currentRound: snapshot.currentRound,
    }});
    if (snapshot.status === "settled" || snapshot.survivorCount <= 1) {
      dispatch({ type: "WINNER_DECLARED" });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);

  // Round resolution from stream.
  useEffect(() => {
    if (!ARENA_ID || !snapshot) return;
    if (streamStatus === "connected" && snapshot.lastRoundState === "RESOLVED") {
      dispatch({ type: "ROUND_RESOLVED", roundNumber: state.currentRound });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ARENA_ID, snapshot, streamStatus]);

  // Restore commitment from localStorage on round/address change.
  useEffect(() => {
    if (!ARENA_ID || !address) return;
    dispatch({ type: "ROUND_ADVANCED", roundNumber: state.currentRound });
    const committed = hasStoredCommitmentForRound(ARENA_ID, state.currentRound, address);
    dispatch({ type: "SET_COMMITTED_FOR_ROUND", committed });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ARENA_ID, state.currentRound, address]);

  const updateArenaState = useCallback(async () => {
    if (!address || !ARENA_ID) return;
    dispatch({ type: "LOADING_ARENA", loading: true });
    try {
      const chainState = await reconcileArenaState(address);
      if (!chainState) return;
      dispatch({ type: "CHAIN_STATE_LOADED", payload: {
        isUserIn: chainState.isUserIn,
        hasWon: chainState.hasWon,
        survivorsCount: chainState.survivorsCount,
        maxCapacity: chainState.maxCapacity,
        currentStake: chainState.currentStake,
        potentialPayout: chainState.potentialPayout,
        entryFee: chainState.entryFee,
        playerCount: chainState.playerCount,
        currentRound: chainState.currentRound,
      }});
      if (chainState.hasWon) {
        const r = await fetch(`/api/payouts/claim-readiness/${encodeURIComponent(ARENA_ID)}`);
        dispatch({ type: "SET_CLAIM_READY", ready: r.ok && ((await r.json()) as { ready: boolean }).ready });
      } else {
        dispatch({ type: "SET_CLAIM_READY", ready: false });
      }
    } catch (error) {
      console.error("Failed to fetch arena state:", error);
    } finally {
      dispatch({ type: "LOADING_ARENA", loading: false });
    }
  }, [address, ARENA_ID, reconcileArenaState]);

  useEffect(() => {
    if (isConnected && address) void updateArenaState();
  }, [isConnected, address, updateArenaState]);

  const reconcileOutcome = useCallback(async (outcome: TransactionOutcome) => {
    await reconcileTransaction(outcome, { arenaId: ARENA_ID });
    await updateArenaState();
    await refreshBalance();
  }, [ARENA_ID, updateArenaState, refreshBalance]);

  const eliminationFeed = streamFeed.length > 0 ? streamFeed : DEMO_ELIMINATION_FEED;

  return (
    <>
      {!ARENA_ID && (
        <div className="w-full bg-yellow-900/80 border-b border-yellow-500/60 px-4 py-2 flex items-center gap-3 text-yellow-300 font-pixel text-[10px] tracking-wider">
          <span className="text-yellow-400 font-bold">⚠ DEMO MODE</span>
          <span>NEXT_PUBLIC_DEMO_ARENA_ID is not set — showing static placeholder data.</span>
        </div>
      )}
      <div className="min-h-screen p-4 md:p-6">
        <div className="max-w-7xl mx-auto">
          <header className="flex justify-between items-center mb-6">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-neon-green" />
              <span className="font-pixel text-sm text-white tracking-wider">INVERSE ARENA</span>
            </div>
            <div className="flex gap-3">
              <button onClick={() => dispatch({ type: "SHOW_ELIMINATION_SUMMARY", show: true })}
                className="border border-neon-pink px-4 py-2 font-pixel text-[8px] text-neon-pink tracking-wider hover:bg-neon-pink/10">
                TEST ELIMINATION
              </button>
              <button className="border border-white/20 px-4 py-2 font-pixel text-[8px] text-white tracking-wider hover:bg-white/5">
                {ARENA_ID ? `STREAM ${streamStatus.toUpperCase()}` : "SOROBAN LIVE"}
              </button>
              <button onClick={() => !isConnected && connect()}
                className="bg-neon-green px-4 py-2 font-pixel text-[8px] text-black tracking-wider hover:bg-neon-green/90 uppercase">
                {isConnected ? (address ? `${address.slice(0, 4)}...${address.slice(-4)}` : "CONNECTED") : "CONNECT WALLET"}
              </button>
            </div>
          </header>

          {isConnected && !state.isJoined && (
            <div className="mb-6 bg-blue-900/20 border border-blue-500/50 p-4 flex justify-between items-center rounded">
              <div className="text-blue-200 text-xs font-pixel">YOU ARE OBSERVING. JOIN THE ARENA TO PLAY.</div>
              <button onClick={() => {
                if (!ARENA_ID) return;
                setTxType("JOIN");
                setTxDetails([{ label: "Action", value: "Join Arena" }, { label: "Entry Fee", value: `${state.entryFee ?? 0} XLM` }, { label: "Arena ID", value: ARENA_ID }]);
                setShowTxModal(true);
              }} className="bg-blue-500 hover:bg-blue-400 text-black font-pixel text-[10px] px-6 py-2">JOIN ROUND</button>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 flex flex-col gap-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <ChooseYourFate />
                <Timer key={state.roundPhase}
                  initialSeconds={state.roundPhase === "commit" ? COMMIT_WINDOW_SECONDS : REVEAL_WINDOW_SECONDS}
                  label={state.roundPhase === "commit" ? "Commit Window Closes In" : "Reveal Window Closes In"}
                  onTimeUp={() => {
                    if (state.roundPhase === "commit") {
                      dispatch({ type: "COMMIT_TIME_EXPIRED" });
                    }
                  }} />
              </div>
              <TensionBar headsPercentage={headsPercentage} tailsPercentage={tailsPercentage} />
              {state.commitTimeExpired && (
                <div className="bg-red-900/20 border border-red-500/50 p-3 text-center rounded">
                  <span className="text-red-300 text-xs font-pixel">TIME EXPIRED — YOU DID NOT SUBMIT A CHOICE THIS ROUND</span>
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 flex-grow">
                <ChoiceCard type="heads" estimatedYield={headsYield} isSelected={state.selectedChoice === "heads"}
                  disabled={!arenaActions.canCommit}
                  onSelect={() => arenaActions.canCommit && dispatch({ type: "SELECT_CHOICE", choice: "heads" })} />
                {isLoadingYield ? (
                  <div className="h-48 bg-zinc-800/50 animate-pulse border-2 border-zinc-700" />
                ) : (
                  <ChoiceCard type="tails" estimatedYield={tailsYield} isSelected={state.selectedChoice === "tails"}
                    disabled={!arenaActions.canCommit}
                    onSelect={() => arenaActions.canCommit && dispatch({ type: "SELECT_CHOICE", choice: "tails" })} />
                )}
              </div>
              {canShowCommitButton(state) && (
                <div className="mt-4 flex justify-center">
                  <button onClick={() => {
                    if (!ARENA_ID) return;
                    dispatch({ type: "BEGIN_COMMIT" });
                    setTxType("COMMIT");
                    setTxDetails([{ label: "Action", value: "Submit Choice" }, { label: "Choice", value: state.selectedChoice!.toUpperCase() }, { label: "Round", value: `#${state.currentRound}` }]);
                    setShowTxModal(true);
                  }} className="w-full md:w-auto bg-neon-pink text-white font-pixel text-lg px-12 py-4 border-4 border-black shadow-[4px_4px_0px_0px_#fff] hover:translate-y-1 hover:shadow-none transition-all uppercase">
                    LOCK IN {state.selectedChoice}
                  </button>
                </div>
              )}
              {canShowRevealButton(state) && (
                <div className="mt-4 flex justify-center">
                  <button onClick={() => {
                    if (!ARENA_ID) return;
                    dispatch({ type: "BEGIN_REVEAL" });
                    setTxType("REVEAL");
                    setTxDetails([{ label: "Action", value: "Reveal Choice" }, { label: "Round", value: `#${state.currentRound}` }]);
                    setShowTxModal(true);
                  }} className="w-full md:w-auto bg-neon-green text-black font-pixel text-lg px-12 py-4 border-4 border-black shadow-[4px_4px_0px_0px_#fff] hover:translate-y-1 hover:shadow-none transition-all uppercase">
                    REVEAL CHOICE
                  </button>
                </div>
              )}
              {playerStatus?.phase === "Reveal" && playerStatus.active && !playerStatus.committed && (
                <div className="mt-4 flex justify-center">
                  <p className="font-pixel text-[10px] text-white/40 uppercase tracking-wider">No commitment made this round — nothing to reveal.</p>
                </div>
              )}
            </div>
          </div>

          <div className="space-y-4">
            {ARENA_ID && <ArenaStateSummary />}
            {state.isLoadingArena || isLoadingYield || state.entryFee === null || state.playerCount === null ? (
              <ArenaStatsSkeleton />
            ) : (
              <>
                <TotalYieldPot amount={state.entryFee * state.playerCount} apr={oracleYield ?? 12.4}
                  freshness={oracleFreshness} ageSeconds={oracleAgeSeconds} />
                <div className="bg-card-bg border border-neon-green p-4">
                  <p className="font-pixel text-[8px] text-white/60 tracking-wider mb-2">SURVIVORS</p>
                  <p className="font-pixel text-3xl text-neon-green">{state.survivors.current}</p>
                  <p className="font-pixel text-sm text-white/40">/{state.survivors.max}</p>
                  <div className="mt-3 h-2 bg-dark-bg">
                    <div className="h-full bg-neon-green" style={{ width: `${state.survivors.max > 0 ? (state.survivors.current / state.survivors.max) * 100 : 0}%` }} />
                  </div>
                </div>
                <div className="bg-white p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-orange-500 text-lg">&#9650;</span>
                    <span className="font-pixel text-[10px] text-black tracking-wider">ELIMINATION FEED</span>
                  </div>
                  <div className="h-0.5 bg-black mb-4" />
                  <div className="space-y-3 text-sm font-mono">
                    {eliminationFeed.map((entry) => (
                      <div key={entry.id} className={`flex justify-between items-center p-3 ${entry.status === "OUT" ? "bg-pink-100" : ""}`}>
                        <span className={entry.status === "OUT" ? "text-neon-pink line-through" : "text-black"}>{entry.label}</span>
                        <span className={`px-3 py-1 text-white text-xs font-bold ${entry.status === "OUT" ? "bg-neon-pink" : "bg-black text-neon-green font-pixel"}`}>{entry.status}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="bg-neon-green p-4">
                  <p className="font-pixel text-[8px] text-black/60 tracking-wider mb-2">YOUR STATUS</p>
                  <p className="font-pixel text-xl text-black italic mb-4">{state.userStatus}</p>
                  <div className="space-y-2 text-[10px] font-mono text-black">
                    <div className="flex justify-between"><span>CURRENT STAKE</span><span className="font-bold">${state.currentStake.toLocaleString()}</span></div>
                    {state.policyNotice && (
                      <div role="alert" className="mt-4 border-2 border-red-500 bg-red-50 p-3 text-left text-xs text-red-800">
                        <p className="font-bold uppercase tracking-widest">Cannot proceed</p>
                        <p className="mt-1">{state.policyNotice}</p>
                      </div>
                    )}
                    {state.hasWon && state.claimReady && !claimAssetGate.canProceed && (
                      <div className="mt-4 border-2 border-amber-500 bg-amber-50 p-3 text-left text-xs text-amber-900">
                        <p className="font-bold uppercase tracking-widest">Asset readiness</p>
                        <p className="mt-1">{claimAssetGate.message}</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {claimAssetGate.phase === "remediation_offered" && <button type="button" onClick={() => setShowTrustline(true)} className="border-2 border-zinc-800 px-3 py-1 text-[10px] font-bold uppercase tracking-wider">Set up trustline</button>}
                          {claimAssetGate.canRetry && <button type="button" onClick={() => void claimAssetGate.check()} className="border-2 border-zinc-800 px-3 py-1 text-[10px] font-bold uppercase tracking-wider">Check again</button>}
                        </div>
                      </div>
                    )}
                    {canShowClaimButton(state) ? (
                      <button onClick={() => {
                        if (!ARENA_ID) return;
                        if (!claimAssetGate.canProceed) { if (claimAssetGate.phase === "remediation_offered") setShowTrustline(true); return; }
                        setTxType("CLAIM");
                        setTxDetails([{ label: "Action", value: "Claim Winnings" }, { label: "Amount", value: "$24,420.00" }, { label: "Arena ID", value: ARENA_ID }]);
                        setShowTxModal(true);
                      }} className="w-full mt-4 bg-black text-neon-green font-pixel text-xs py-3 border-2 border-black hover:bg-zinc-900 uppercase">CLAIM WINNINGS</button>
                    ) : (
                      <div className="flex justify-between"><span>POTENTIAL PAYOUT</span><span className="font-bold">${state.potentialPayout.toLocaleString()}</span></div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-white/5 flex flex-wrap justify-between items-center text-white/40 font-mono text-[9px] uppercase tracking-[0.2em] gap-4">
          <div className="flex gap-6 md:gap-10">
            <div><span className="block mb-1 text-zinc-600">VALIDATED</span><span>TX: 0x82F...A12C VERIFIED</span></div>
            <div><span className="block mb-1 text-zinc-600">YIELD HARVEST COMPLETE</span><span className="text-neon-green">+8.002%</span></div>
          </div>
          <div className="text-neon-pink font-pixel text-[8px]">WARNING: 15 SECONDS TO LOCK-IN</div>
          <div><span className="block mb-1 text-zinc-600">BLOCK</span><span>#882193-B MINING</span></div>
        </div>
      </div>

      <AssetTrustlinePrompt isOpen={showTrustline} onClose={() => setShowTrustline(false)}
        remediation={claimAssetGate.remediation} message={claimAssetGate.message}
        phase={claimAssetGate.phase === "remediating" ? "remediating" : claimAssetGate.phase === "blocked" ? "blocked" : "remediation_offered"}
        onConfirm={async () => { await claimAssetGate.remediate(); if (claimAssetGate.canProceed) setShowTrustline(false); }}
        onRetry={() => void claimAssetGate.check()} actionLabel="claim your winnings" />

      <TransactionModal isOpen={showTxModal} onClose={() => setShowTxModal(false)}
        title={txType === "JOIN" ? "Join Arena" : txType === "COMMIT" ? "Commit Choice" : txType === "REVEAL" ? "Reveal Choice" : "Claim Winnings"}
        description={txType === "CLAIM" ? "Withdraw your earnings" : txType === "JOIN" ? "Confirm entry to arena" : txType === "COMMIT" ? "Lock in your prediction" : "Reveal the choice you committed to"}
        details={txDetails}
        confirmLabel={txType === "JOIN" ? "Sign & Join" : txType === "COMMIT" ? "Sign & Commit" : txType === "REVEAL" ? "Sign & Reveal" : "Sign & Claim"}
        onConfirm={async ({ onSigned }) => {
          if (!address || !txType) return;
          let buildTransaction: (() => Promise<Transaction>) | null = null;
          let intentKind: IntentKind | null = null;
          let actionKey: string | null = null;
          if (txType === "JOIN") {
            buildTransaction = () => buildJoinArenaTransaction(address, ARENA_ID);
            intentKind = "join_arena"; actionKey = `join_arena:${ARENA_ID}`;
          } else if (txType === "COMMIT" && state.selectedChoice) {
            const choice = state.selectedChoice === "heads" ? "Heads" : "Tails";
            buildTransaction = () => buildSubmitCommitmentTransaction(address, ARENA_ID, choice, state.currentRound);
            intentKind = "commit_choice"; actionKey = `commit_choice:${ARENA_ID}:${state.currentRound}`;
          } else if (txType === "REVEAL") {
            buildTransaction = () => buildRevealChoiceTransaction(address, ARENA_ID, state.currentRound);
            intentKind = "reveal_choice"; actionKey = `reveal_choice:${ARENA_ID}:${state.currentRound}`;
          } else if (txType === "CLAIM") {
            buildTransaction = () => buildClaimWinningsTransaction(address, ARENA_ID);
            intentKind = "claim"; actionKey = `claim:${ARENA_ID}`;
          } else { return; }

          const buildTransactionForIntent = buildTransaction;
          let policyRejected = false;
          const checkedBuild = async () => {
            const tx = await buildTransactionForIntent();
            try { evaluateSigningRequest(tx.toXDR(), txType); }
            catch (error) {
              if (error instanceof SigningPolicyError) {
                policyRejected = true;
                dispatch({ type: "SET_POLICY_NOTICE", notice: error.message });
                setShowTxModal(false);
              }
              throw error;
            }
            return tx;
          };

          let outcome: TransactionOutcome;
          try {
            const { hash } = await runTrackedTransaction({ kind: intentKind!, actionKey: actionKey!, publicKey: address, buildTransaction: checkedBuild, signTransaction, submitSignedTransaction, networkPassphrase: NETWORK_PASSPHRASE, onSigned });
            outcome = { status: "SUCCESS", hash };
          } catch (e) {
            if (policyRejected) return;
            outcome = captureTransactionOutcome(e);
            void reconcileOutcome(outcome).catch((err) => console.error("Reconciliation failed:", err));
            throw e;
          }
          await reconcileOutcome(outcome);
          if (txType === "COMMIT") {
            dispatch({ type: "COMMIT_CONFIRMED" });
          } else if (txType === "REVEAL") {
            if (address) clearCommitmentForRound(ARENA_ID, state.currentRound, address);
            dispatch({ type: "REVEAL_CONFIRMED" });
          }
          setShowTxModal(false);
        }} />

      <RoundResolvedOverlay isOpen={state.isRoundResolved} status="survived" roundNumber={state.currentRound}
        livePopulation={state.survivors.current} totalPopulation={state.survivors.max}
        eliminatedPercent={Math.round(((state.survivors.max - state.survivors.current) / state.survivors.max) * 100)}
        currentPot={Math.round(state.currentStake * 3)} potGrowth={12}
        majorityChoice={state.selectedChoice ?? "heads"} txHash="0x7a3f...8b2c"
        onProceed={() => dispatch({ type: "ROUND_ADVANCED", roundNumber: state.currentRound + 1 })} />

      <EliminationSummaryOverlay isOpen={state.showEliminationSummary} roundsSurvived={3} yieldEarned={1.20}
        isSorobanSynced={true} vaultStatus="safe" lockTimeRemaining={12}
        txLedgerUrl="https://stellar.expert/explorer/testnet"
        onExitToLobby={() => dispatch({ type: "SHOW_ELIMINATION_SUMMARY", show: false })}
        onJoinNewArena={() => dispatch({ type: "SHOW_ELIMINATION_SUMMARY", show: false })} />
    </>
  );
}

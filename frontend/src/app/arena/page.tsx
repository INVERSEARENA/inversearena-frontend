"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Timer,
  ChoiceCard,
  TensionBar,
  ChooseYourFate,
  TotalYieldPot,
  RoundResolvedOverlay,
  EliminationSummaryOverlay,
} from "@/components/arena/core";
import { useWallet } from "@/shared-d/hooks/useWallet";
import { TransactionModal } from "@/components/modals/TransactionModal";
import {
  buildJoinArenaTransaction,
  buildSubmitChoiceTransaction,
  buildClaimWinningsTransaction,
  submitSignedTransaction,
  fetchArenaState
} from "@/shared-d/utils/stellar-transactions";

export default function ArenaPage() {
  const { isConnected, address, connect, signTransaction, refreshBalance } = useWallet();
  const [selectedChoice, setSelectedChoice] = useState<"heads" | "tails" | null>(null);
  const [isJoined, setIsJoined] = useState(false);
  const [hasWon, setHasWon] = useState(false);
  const [showEliminationSummary, setShowEliminationSummary] = useState(false);
  const [survivors, setSurvivors] = useState({ current: 128, max: 1024 });
  const [userStatus, setUserStatus] = useState("STILL IN");
  const [currentStake, setCurrentStake] = useState(1200);
  const [potentialPayout, setPotentialPayout] = useState(24420);
  const [isLoadingArena, setIsLoadingArena] = useState(false);

  // Round Resolution State
  const [isRoundResolved, setIsRoundResolved] = useState(false);
  const [roundStatus, setRoundStatus] = useState<"survived" | "eliminated">("survived");
  const [currentRound, setCurrentRound] = useState(1);

  // Transaction Modal State
  const [showTxModal, setShowTxModal] = useState(false);
  const [txType, setTxType] = useState<"JOIN" | "SUBMIT" | "CLAIM" | null>(null);
  const [txDetails, setTxDetails] = useState<{ label: string; value: string | number }[]>([]);

  // Mock Arena ID
  const ARENA_ID = "C...ARENA";

  // Mock data - would come from API/contract
  const headsYield = 42;
  const tailsYield = 58;
  const headsPercentage = 42;
  const tailsPercentage = 58;

  const updateArenaState = useCallback(async () => {
    if (!address) return;
    setIsLoadingArena(true);
    try {
      const state = await fetchArenaState(ARENA_ID, address);
      setSurvivors({ current: state.survivorsCount, max: state.maxCapacity });
      setIsJoined(state.isUserIn);
      setHasWon(state.hasWon);
      setUserStatus(state.hasWon ? "WINNER!" : "STILL IN");
      setCurrentStake(state.currentStake);
      setPotentialPayout(state.potentialPayout);
    } catch (error) {
      console.error("Failed to fetch arena state:", error);
    } finally {
      setIsLoadingArena(false);
    }
  }, [address]);

  useEffect(() => {
    if (isConnected && address) {
      updateArenaState();
    }
  }, [isConnected, address, updateArenaState]);

  return (
    <>
      <div className="min-h-screen p-4 md:p-6">
        <div className="max-w-7xl mx-auto">
          {/* Header */}
          <header className="flex justify-between items-center mb-6">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-neon-green" />
              <span className="font-pixel text-sm text-white tracking-wider">
                INVERSE ARENA
              </span>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setShowEliminationSummary(true)}
                className="border border-neon-pink px-4 py-2 font-pixel text-[8px] text-neon-pink tracking-wider hover:bg-neon-pink/10"
              >
                TEST ELIMINATION
              </button>
              <button className="border border-white/20 px-4 py-2 font-pixel text-[8px] text-white tracking-wider hover:bg-white/5">
                SOROBAN LIVE
              </button>
              <button
                onClick={() => !isConnected && connect()}
                className="bg-neon-green px-4 py-2 font-pixel text-[8px] text-black tracking-wider hover:bg-neon-green/90 uppercase"
              >
                {isConnected ? (address ? `${address.slice(0, 4)}...${address.slice(-4)}` : "CONNECTED") : "CONNECT WALLET"}
              </button>
            </div>
          </header>

          {/* Join Arena Overlay / Button (Demo) */}
          {isConnected && !isJoined && (
            <div className="mb-6 bg-blue-900/20 border border-blue-500/50 p-4 flex justify-between items-center rounded">
              <div className="text-blue-200 text-xs font-pixel">
                YOU ARE OBSERVING. JOIN THE ARENA TO PLAY.
              </div>
              <button
                onClick={() => {
                  setTxType("JOIN");
                  setTxDetails([
                    { label: "Action", value: "Join Arena" },
                    { label: "Entry Fee", value: "100 XLM" }, // Example
                    { label: "Arena ID", value: ARENA_ID },
                  ]);
                  setShowTxModal(true);
                }}
                className="bg-blue-500 hover:bg-blue-400 text-black font-pixel text-[10px] px-6 py-2"
              >
                JOIN ROUND
              </button>
            </div>
          )}

          {/* Main grid */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Left column - Game area */}
            <div className="lg:col-span-2 flex flex-col gap-4">
              {/* Top row: Choose Your Fate + Timer */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <ChooseYourFate />
                <Timer
                  initialSeconds={15}
                  onTimeUp={() => {
                    // Simulate round resolution
                    const userSurvived = selectedChoice === "tails"; // Mock: tails wins
                    setRoundStatus(userSurvived ? "survived" : "eliminated");
                    setIsRoundResolved(true);
                  }}
                />
              </div>

              {/* Tension Bar */}
              <TensionBar
                headsPercentage={headsPercentage}
                tailsPercentage={tailsPercentage}
              />

              {/* Choice Cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 flex-grow">
                <ChoiceCard
                  type="heads"
                  estimatedYield={headsYield}
                  isSelected={selectedChoice === "heads"}
                  onSelect={() => setSelectedChoice("heads")}
                />
                <ChoiceCard
                  type="tails"
                  estimatedYield={tailsYield}
                  isSelected={selectedChoice === "tails"}
                  onSelect={() => setSelectedChoice("tails")}
                />
              </div>

              {/* Lock In Button */}
              {selectedChoice && isJoined && (
                <div className="mt-4 flex justify-center">
                  <button
                    onClick={() => {
                      setTxType("SUBMIT");
                      setTxDetails([
                        { label: "Action", value: "Submit Choice" },
                        { label: "Choice", value: selectedChoice.toUpperCase() },
                        { label: "Round", value: "#12" }, // Mock
                      ]);
                      setShowTxModal(true);
                    }}
                    className="w-full md:w-auto bg-neon-pink text-white font-pixel text-lg px-12 py-4 border-4 border-black shadow-[4px_4px_0px_0px_#fff] hover:translate-y-1 hover:shadow-none transition-all uppercase"
                  >
                    LOCK IN {selectedChoice}
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Right column - Stats */}
          <div className="space-y-4">
            <TotalYieldPot amount={42850.12} apr={12.4} />

            {/* Survivors placeholder */}
            <div className="bg-card-bg border border-neon-green p-4">
              <p className="font-pixel text-[8px] text-white/60 tracking-wider mb-2">
                SURVIVORS
              </p>
              <p className="font-pixel text-3xl text-neon-green">{survivors.current}</p>
              <p className="font-pixel text-sm text-white/40">/{survivors.max}</p>
              <div className="mt-3 h-2 bg-dark-bg">
                <div className="h-full bg-neon-green w-[12.5%]" />
              </div>
            </div>

            {/* Elimination Feed */}
            <div className="bg-white p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-orange-500 text-lg">&#9650;</span>
                <span className="font-pixel text-[10px] text-black tracking-wider">
                  ELIMINATION FEED
                </span>
              </div>
              <div className="h-0.5 bg-black mb-4" />

              <div className="space-y-3 text-sm font-mono">
                {/* Eliminated entries */}
                <div className="flex justify-between items-center bg-pink-100 p-3">
                  <span className="text-neon-pink line-through">S-6782-5</span>
                  <span className="bg-neon-pink px-3 py-1 text-white text-xs font-bold">OUT</span>
                </div>
                <div className="flex justify-between items-center bg-pink-100 p-3">
                  <span className="text-neon-pink line-through">S-3382-8</span>
                  <span className="bg-neon-pink px-3 py-1 text-white text-xs font-bold">OUT</span>
                </div>
                <div className="flex justify-between items-center bg-pink-100 p-3">
                  <span className="text-neon-pink line-through">K-0001-A</span>
                  <span className="bg-neon-pink px-3 py-1 text-white text-xs font-bold">OUT</span>
                </div>
                {/* Active entry */}
                <div className="flex justify-between items-center p-3">
                  <span className="text-black">S-9921-W</span>
                  <span className="bg-black px-3 py-1 text-neon-green text-xs font-pixel">ACTIVE</span>
                </div>
              </div>
            </div>

            {/* Your Status placeholder */}
            <div className="bg-neon-green p-4">
              <p className="font-pixel text-[8px] text-black/60 tracking-wider mb-2">
                YOUR STATUS
              </p>
              <p className="font-pixel text-xl text-black italic mb-4">
                {userStatus}
              </p>
              <div className="space-y-2 text-[10px] font-mono text-black">
                <div className="flex justify-between">
                  <span>CURRENT STAKE</span>
                  <span className="font-bold">${currentStake.toLocaleString()}</span>
                </div>
                {hasWon ? (
                  <button
                    onClick={() => {
                      setTxType("CLAIM");
                      setTxDetails([
                        { label: "Action", value: "Claim Winnings" },
                        { label: "Amount", value: "$24,420.00" },
                        { label: "Arena ID", value: ARENA_ID },
                      ]);
                      setShowTxModal(true);
                    }}
                    className="w-full mt-4 bg-black text-neon-green font-pixel text-xs py-3 border-2 border-black hover:bg-zinc-900 uppercase"
                  >
                    CLAIM WINNINGS
                  </button>
                ) : (
                  <div className="flex justify-between">
                    <span>POTENTIAL PAYOUT</span>
                    <span className="font-bold">${potentialPayout.toLocaleString()}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Terminal Footer */}
        <div className="mt-8 pt-6 border-t border-white/5 flex flex-wrap justify-between items-center text-white/40 font-mono text-[9px] uppercase tracking-[0.2em] gap-4">
          <div className="flex gap-6 md:gap-10">
            <div>
              <span className="block mb-1 text-zinc-600">VALIDATED</span>
              <span>TX: 0x82F...A12C VERIFIED</span>
            </div>
            <div>
              <span className="block mb-1 text-zinc-600">YIELD HARVEST COMPLETE</span>
              <span className="text-neon-green">+8.002%</span>
            </div>
          </div>

          <div className="text-neon-pink font-pixel text-[8px]">
            WARNING: 15 SECONDS TO LOCK-IN
          </div>

          <div>
            <span className="block mb-1 text-zinc-600">BLOCK</span>
            <span>#882193-B MINING</span>
          </div>
        </div>
      </div>

      <TransactionModal
        isOpen={showTxModal}
        onClose={() => setShowTxModal(false)}
        title={txType === "JOIN" ? "Join Arena" : txType === "SUBMIT" ? "Submit Choice" : "Claim Winnings"}
        description={txType === "CLAIM" ? "Withdraw your earnings" : (txType === "JOIN" ? "Confirm entry to arena" : "Lock in your prediction")}
        details={txDetails}
        confirmLabel={txType === "JOIN" ? "Sign & Join" : (txType === "SUBMIT" ? "Sign & Submit" : "Sign & Claim")}
        onConfirm={async () => {
          if (!address || !txType) return;

          try {
            let tx;
            if (txType === "JOIN") {
              tx = await buildJoinArenaTransaction(address, ARENA_ID, 100);
            } else if (txType === "SUBMIT" && selectedChoice) {
              tx = await buildSubmitChoiceTransaction(address, ARENA_ID, selectedChoice === "heads" ? "Heads" : "Tails", 12);
            } else if (txType === "CLAIM") {
              tx = await buildClaimWinningsTransaction(address, ARENA_ID);
            } else {
              return;
            }

            const signedXdr = await signTransaction(tx.toXDR());
            await submitSignedTransaction(signedXdr);

            // Trigger real-time updates
            await refreshBalance();
            await updateArenaState();

            setShowTxModal(false);
          } catch (e) {
            console.error(e);
            throw e;
          }
        }}
      />

      {/* Round Resolved Overlay */}
      <RoundResolvedOverlay
        isOpen={isRoundResolved}
        status={roundStatus}
        roundNumber={currentRound}
        livePopulation={survivors.current}
        totalPopulation={survivors.max}
        eliminatedPercent={Math.round(((survivors.max - survivors.current) / survivors.max) * 100)}
        currentPot={Math.round(currentStake * 3)}
        potGrowth={12}
        majorityChoice={selectedChoice ?? "heads"}
        txHash="0x7a3f...8b2c"
        onProceed={() => {
          setIsRoundResolved(false);
          setCurrentRound((prev) => prev + 1);
          setSelectedChoice(null);
        }}
      />

      {/* Elimination Summary Overlay */}
      <EliminationSummaryOverlay
        isOpen={showEliminationSummary}
        roundsSurvived={3}
        yieldEarned={1.20}
        isSorobanSynced={true}
        vaultStatus="safe"
        lockTimeRemaining={12}
        txLedgerUrl="https://stellar.expert/explorer/testnet"
        onExitToLobby={() => setShowEliminationSummary(false)}
        onJoinNewArena={() => setShowEliminationSummary(false)}
      />
    </>
  );
}

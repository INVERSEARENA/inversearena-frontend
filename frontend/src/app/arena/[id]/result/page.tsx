"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useWallet } from "@/features/wallet/useWallet";
import { SocialCard } from "@/components/arena-v2/modals/SocialCard";

interface RoundSummary {
  round: number;
  eliminated: number;
  survivors: number;
}

interface ResultData {
  arenaId: string;
  winnerAddress: string;
  entryFeesTotal: number;
  yieldEarned: number;
  totalPrize: number;
  rounds: RoundSummary[];
  totalPlayers: number;
  userFinishPosition: number | null;
  gameState: string;
}

// Truncate a wallet address for display
function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// Mock fetcher — replace with real API calls to:
//   GET /arenas/:id/stats  +  GET /arenas/:id/rounds
async function fetchResultData(arenaId: string, userAddress?: string | null): Promise<ResultData> {
  await new Promise((r) => setTimeout(r, 600));
  const rounds: RoundSummary[] = [
    { round: 1, eliminated: 512, survivors: 512 },
    { round: 2, eliminated: 256, survivors: 256 },
    { round: 3, eliminated: 128, survivors: 128 },
    { round: 4, eliminated: 64, survivors: 64 },
    { round: 5, eliminated: 63, survivors: 1 },
  ];
  return {
    arenaId,
    winnerAddress: "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RIGLO47E2WU7CXZS7SB",
    entryFeesTotal: 102_400,
    yieldEarned: 3_280.5,
    totalPrize: 105_680.5,
    rounds,
    totalPlayers: 1024,
    userFinishPosition: userAddress ? 64 : null,
    gameState: "Finished",
  };
}

function TrophyIcon() {
  return (
    <svg viewBox="0 0 48 48" width="64" height="64" fill="none" aria-hidden="true">
      <path d="M12 4h24v20a12 12 0 0 1-24 0V4Z" fill="#39FF14" stroke="#000" strokeWidth="2" />
      <path d="M4 6h8v12A8 8 0 0 1 4 6Z" fill="#39FF14" stroke="#000" strokeWidth="2" />
      <path d="M44 6h-8v12a8 8 0 0 0 8-8V6Z" fill="#39FF14" stroke="#000" strokeWidth="2" />
      <rect x="20" y="36" width="8" height="6" fill="#39FF14" stroke="#000" strokeWidth="2" />
      <rect x="14" y="42" width="20" height="3" fill="#39FF14" stroke="#000" strokeWidth="2" />
    </svg>
  );
}

export default function ArenaResultPage() {
  const params = useParams();
  const router = useRouter();
  const { publicKey } = useWallet();
  const arenaId = Array.isArray(params.id) ? params.id[0] : params.id;

  const [result, setResult] = useState<ResultData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!arenaId) return;
    setLoading(true);
    fetchResultData(arenaId, publicKey)
      .then(setResult)
      .catch(() => setError("Failed to load game results. Please try again."))
      .finally(() => setLoading(false));
  }, [arenaId, publicKey]);

  const handleShare = (platform: "twitter" | "copy") => {
    if (!result) return;
    const text = `I just witnessed Arena #${arenaId} end! Winner took home ${result.totalPrize.toLocaleString()} XLM on @InverseArena 🏆`;
    if (platform === "twitter") {
      window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, "_blank");
    } else {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black">
        <div className="font-pixel text-neon-green text-sm animate-pulse tracking-widest">
          LOADING RESULTS...
        </div>
      </div>
    );
  }

  if (error || !result) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-black gap-4">
        <p className="font-pixel text-neon-pink text-sm">{error ?? "Results unavailable."}</p>
        <button
          onClick={() => router.push("/dashboard/games")}
          className="bg-neon-green text-black font-pixel text-xs px-6 py-2 hover:opacity-90"
        >
          BACK TO GAMES
        </button>
      </div>
    );
  }

  const isWinner = publicKey && result.winnerAddress === publicKey;

  return (
    <div className="min-h-screen bg-black text-white p-4 md:p-8">
      <div className="max-w-4xl mx-auto space-y-8">

        {/* Winner announcement */}
        <section className="border border-neon-green p-6 text-center space-y-4">
          <div className="flex justify-center">
            <TrophyIcon />
          </div>
          <p className="font-pixel text-[10px] text-neon-green tracking-widest uppercase">
            ARENA #{arenaId} — GAME OVER
          </p>
          <h1 className="font-pixel text-xl md:text-3xl text-white">
            {isWinner ? "YOU WON!" : "WINNER DECLARED"}
          </h1>
          <p className="font-mono text-sm text-neon-green break-all">
            {result.winnerAddress}
          </p>
          <p className="font-pixel text-[9px] text-white/50 tracking-wider">
            {shortAddress(result.winnerAddress)} SURVIVED ALL {result.rounds.length} ROUNDS
          </p>
        </section>

        {/* Prize breakdown */}
        <section className="border border-white/20 p-6 space-y-4">
          <h2 className="font-pixel text-[10px] text-white/60 tracking-widest uppercase">
            PRIZE BREAKDOWN
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="border border-white/10 p-4 space-y-1">
              <p className="font-pixel text-[8px] text-white/50 tracking-wider">ENTRY FEES</p>
              <p className="font-pixel text-lg text-white">
                {result.entryFeesTotal.toLocaleString()} XLM
              </p>
            </div>
            <div className="border border-white/10 p-4 space-y-1">
              <p className="font-pixel text-[8px] text-white/50 tracking-wider">YIELD EARNED</p>
              <p className="font-pixel text-lg text-neon-green">
                +{result.yieldEarned.toLocaleString()} XLM
              </p>
            </div>
            <div className="border border-neon-green p-4 space-y-1">
              <p className="font-pixel text-[8px] text-neon-green tracking-wider">TOTAL PRIZE</p>
              <p className="font-pixel text-lg text-neon-green">
                {result.totalPrize.toLocaleString()} XLM
              </p>
            </div>
          </div>
        </section>

        {/* My result */}
        {publicKey && (
          <section className="border border-white/20 p-6 space-y-2">
            <h2 className="font-pixel text-[10px] text-white/60 tracking-widest uppercase mb-4">
              YOUR RESULT
            </h2>
            {isWinner ? (
              <p className="font-pixel text-sm text-neon-green">
                YOU ARE THE WINNER — POSITION 1 OF {result.totalPlayers.toLocaleString()}
              </p>
            ) : result.userFinishPosition ? (
              <p className="font-pixel text-sm text-white">
                YOU FINISHED IN POSITION {result.userFinishPosition.toLocaleString()} OF{" "}
                {result.totalPlayers.toLocaleString()} PLAYERS
              </p>
            ) : (
              <p className="font-pixel text-sm text-white/50">
                YOU WERE NOT IN THIS ARENA
              </p>
            )}
          </section>
        )}

        {/* Round timeline */}
        <section className="border border-white/20 p-6 space-y-4">
          <h2 className="font-pixel text-[10px] text-white/60 tracking-widest uppercase">
            ROUND TIMELINE
          </h2>
          <div className="space-y-2">
            {result.rounds.map((r) => (
              <div
                key={r.round}
                className="flex items-center justify-between border border-white/10 p-3"
              >
                <span className="font-pixel text-[9px] text-white/60 tracking-wider">
                  ROUND {r.round}
                </span>
                <div className="flex gap-6">
                  <span className="font-pixel text-[9px] text-neon-pink">
                    -{r.eliminated} ELIMINATED
                  </span>
                  <span className="font-pixel text-[9px] text-neon-green">
                    {r.survivors} SURVIVED
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Share card + CTAs */}
        <section className="space-y-4">
          <h2 className="font-pixel text-[10px] text-white/60 tracking-widest uppercase">
            SHARE YOUR RESULT
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <SocialCard
              label="SHARE ON X (TWITTER)"
              icon={
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.745l7.73-8.835L1.254 2.25H8.08l4.259 5.622 5.905-5.622Zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
              }
              onClick={() => handleShare("twitter")}
              variant="outline"
            />
            <SocialCard
              label="COPY SHARE TEXT"
              icon={
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              }
              onClick={() => handleShare("copy")}
              variant="filled"
            />
          </div>
        </section>

        {/* Play again CTA */}
        <div className="flex flex-col md:flex-row gap-3 pt-4">
          <button
            onClick={() => router.push("/dashboard/games")}
            className="flex-1 bg-neon-green text-black font-pixel text-xs py-4 hover:opacity-90 uppercase tracking-widest"
          >
            FIND A NEW ARENA
          </button>
          <button
            onClick={() => router.push("/dashboard")}
            className="flex-1 border border-white/20 text-white font-pixel text-xs py-4 hover:bg-white/5 uppercase tracking-widest"
          >
            BACK TO DASHBOARD
          </button>
        </div>

      </div>
    </div>
  );
}

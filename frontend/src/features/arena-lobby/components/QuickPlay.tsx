"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiClient, ApiError } from "@/shared/lib/api/client";
import { localStorageManager, StorageKey } from "@/shared/lib/localStorage";

export interface QuickPlayPreferences {
  asset: string;       // e.g. "XLM", "USDC"
  maxStake: number;
  preferredSize: "small" | "medium" | "large" | "any";
}

export interface QuickPlayMatch {
  arenaId: string;
  arenaName: string;
  currency: string;
  entryFee: number;
  currentPlayers: number;
  maxPlayers: number;
  estimatedStartSecs: number; // seconds until arena expected to start
}

const DEFAULT_PREFS: QuickPlayPreferences = {
  asset: "XLM",
  maxStake: 1000,
  preferredSize: "any",
};

function loadPrefs(): QuickPlayPreferences {
  const saved = localStorageManager.getItem<Partial<QuickPlayPreferences> | null>(StorageKey.QUICK_PLAY_PREFS, null);
  return saved ? { ...DEFAULT_PREFS, ...saved } : DEFAULT_PREFS;
}

function savePrefs(prefs: QuickPlayPreferences) {
  localStorageManager.setItem(StorageKey.QUICK_PLAY_PREFS, prefs);
}

export function useQuickPlay(walletAddress: string | undefined) {
  const [prefs, setPrefs] = useState<QuickPlayPreferences>(DEFAULT_PREFS);
  const [match, setMatch] = useState<QuickPlayMatch | null>(null);
  const [status, setStatus] = useState<"idle" | "searching" | "found" | "none" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setPrefs(loadPrefs()); }, []);

  const updatePrefs = useCallback((next: Partial<QuickPlayPreferences>) => {
    setPrefs((p) => {
      const updated = { ...p, ...next };
      savePrefs(updated);
      return updated;
    });
  }, []);

  const findArena = useCallback(async () => {
    if (!walletAddress) { setError("Connect a wallet first."); return; }
    setStatus("searching");
    setError(null);
    try {
      const params = new URLSearchParams({
        asset: prefs.asset,
        maxStake: String(prefs.maxStake),
        size: prefs.preferredSize,
        player: walletAddress,
      });
      const data = await apiClient.get<QuickPlayMatch>("/api/arenas/quick-play", { params });
      setMatch(data);
      setStatus("found");
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setStatus("none");
        setMatch(null);
        return;
      }
      setError(err instanceof Error ? err.message : "Could not find an arena.");
      setStatus("error");
    }
  }, [walletAddress, prefs]);

  const reset = useCallback(() => { setStatus("idle"); setMatch(null); setError(null); }, []);

  return { prefs, updatePrefs, match, status, error, findArena, reset };
}

interface QuickPlayButtonProps {
  walletAddress: string | undefined;
}

export function QuickPlayButton({ walletAddress }: QuickPlayButtonProps) {
  const router = useRouter();
  const [sheetOpen, setSheetOpen] = useState(false);
  const { prefs, updatePrefs, match, status, error, findArena, reset } = useQuickPlay(walletAddress);

  const handlePlay = async () => {
    if (sheetOpen) return;
    await findArena();
  };

  const handleJoin = () => {
    if (match) router.push(`/arena/${match.arenaId}`);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setSheetOpen((v) => !v)}
        className="flex items-center gap-2 rounded-sm bg-[#37FF1C] px-5 py-2.5 font-mono text-sm font-bold text-black transition-all hover:bg-[#2be012] hover:shadow-lg hover:shadow-[#37FF1C]/20 focus:outline-none focus:ring-2 focus:ring-[#37FF1C] focus:ring-offset-2 focus:ring-offset-black"
        aria-expanded={sheetOpen}
      >
        <BoltIcon className="size-4" />
        QUICK PLAY
      </button>

      {sheetOpen && (
        <QuickPlaySheet
          prefs={prefs}
          onUpdatePrefs={updatePrefs}
          onPlay={async () => {
            await handlePlay();
          }}
          onJoin={handleJoin}
          onCreateArena={() => router.push("/arena/create")}
          onClose={() => { setSheetOpen(false); reset(); }}
          match={match}
          status={status}
          error={error}
        />
      )}
    </>
  );
}

interface SheetProps {
  prefs: QuickPlayPreferences;
  onUpdatePrefs: (p: Partial<QuickPlayPreferences>) => void;
  onPlay: () => Promise<void>;
  onJoin: () => void;
  onCreateArena: () => void;
  onClose: () => void;
  match: QuickPlayMatch | null;
  status: ReturnType<typeof useQuickPlay>["status"];
  error: string | null;
}

function QuickPlaySheet({
  prefs, onUpdatePrefs, onPlay, onJoin, onCreateArena, onClose, match, status, error,
}: SheetProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Quick Play preferences"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={ref}
        className="w-full max-w-sm border border-[#1c2739] bg-[#060f1a] p-6 font-mono shadow-2xl"
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-sm font-bold tracking-widest text-[#37FF1C]">QUICK PLAY</h2>
          <button type="button" onClick={onClose} className="text-zinc-500 hover:text-white">
            ✕
          </button>
        </div>

        {/* Preferences */}
        <div className="space-y-4">
          <Field label="ASSET">
            <select
              value={prefs.asset}
              onChange={(e) => onUpdatePrefs({ asset: e.target.value })}
              className="w-full border border-[#1c2739] bg-black px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#37FF1C]"
            >
              {["XLM", "USDC", "EURC"].map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </Field>

          <Field label="MAX STAKE">
            <input
              type="number"
              min={1}
              value={prefs.maxStake}
              onChange={(e) => onUpdatePrefs({ maxStake: Number(e.target.value) })}
              className="w-full border border-[#1c2739] bg-black px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#37FF1C]"
            />
          </Field>

          <Field label="SIZE">
            <div className="flex gap-2">
              {(["any", "small", "medium", "large"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onUpdatePrefs({ preferredSize: s })}
                  className={`flex-1 py-1.5 text-xs font-bold transition-colors ${
                    prefs.preferredSize === s
                      ? "bg-[#37FF1C] text-black"
                      : "border border-[#1c2739] text-zinc-400 hover:border-[#37FF1C]/40"
                  }`}
                >
                  {s.toUpperCase()}
                </button>
              ))}
            </div>
          </Field>
        </div>

        {/* Result */}
        <div className="mt-5">
          {status === "idle" && (
            <button
              type="button"
              onClick={onPlay}
              className="w-full bg-[#37FF1C] py-3 text-sm font-bold text-black hover:bg-[#2be012]"
            >
              FIND BEST ARENA
            </button>
          )}

          {status === "searching" && (
            <p className="text-center text-xs text-zinc-400 animate-pulse">Searching…</p>
          )}

          {status === "found" && match && (
            <div className="border border-[#37FF1C]/30 bg-black/40 p-4">
              <p className="text-xs text-zinc-400">BEST MATCH</p>
              <p className="mt-1 text-sm font-bold text-white">{match.arenaName}</p>
              <p className="text-xs text-zinc-400">
                {match.entryFee} {match.currency} · {match.currentPlayers}/{match.maxPlayers} players ·
                starts ~{Math.round(match.estimatedStartSecs / 60)}m
              </p>
              <button
                type="button"
                onClick={onJoin}
                className="mt-3 w-full bg-[#37FF1C] py-2.5 text-sm font-bold text-black hover:bg-[#2be012]"
              >
                JOIN NOW
              </button>
            </div>
          )}

          {status === "none" && (
            <div className="text-center">
              <p className="text-xs text-zinc-400">No open arenas match your preferences.</p>
              <button
                type="button"
                onClick={onCreateArena}
                className="mt-3 w-full border border-[#37FF1C]/40 py-2.5 text-sm font-bold text-[#37FF1C] hover:border-[#37FF1C]"
              >
                CREATE FROM TEMPLATE
              </button>
            </div>
          )}

          {status === "error" && (
            <p className="text-xs text-red-400">{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-[10px] font-bold tracking-widest text-zinc-500">
        {label}
      </label>
      {children}
    </div>
  );
}

function BoltIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>
  );
}

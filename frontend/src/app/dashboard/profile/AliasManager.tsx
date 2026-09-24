"use client";

/**
 * AliasManager (#1414)
 *
 * Lets a player set or rotate their privacy-preserving public alias.
 * Wallet addresses are never displayed here — the alias is the public identity.
 * Shows the full rotation history (newest first) so historical game results
 * remain attributable.
 */

import React, { useState, useEffect, useCallback } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface AliasHistoryEntry {
  alias: string;
  setAt: string;
  retiredAt: string | null;
}

interface AliasData {
  alias: string;
  history: AliasHistoryEntry[];
}

// ── Component ─────────────────────────────────────────────────────────────────

interface AliasManagerProps {
  /** Current alias value, if the user already has one. */
  currentAlias?: string | null;
}

export function AliasManager({ currentAlias: initialAlias }: AliasManagerProps) {
  const [currentAlias, setCurrentAlias] = useState<string | null>(initialAlias ?? null);
  const [history, setHistory] = useState<AliasHistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Fetch history when the user opens the panel
  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/users/me/alias/history", {
        credentials: "include",
      });
      if (!res.ok) return;
      const data = (await res.json()) as { history: AliasHistoryEntry[] };
      setHistory(data.history);
    } catch {
      // Non-fatal
    }
  }, []);

  useEffect(() => {
    if (showHistory) {
      loadHistory();
    }
  }, [showHistory, loadHistory]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;

    setSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch("/api/users/me/alias", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ alias: trimmed }),
      });

      const data = (await res.json()) as AliasData & { error?: { message: string } };

      if (!res.ok) {
        setError(data.error?.message ?? "Failed to update alias");
        return;
      }

      setCurrentAlias(data.alias);
      setHistory(data.history.slice().reverse()); // newest first
      setEditMode(false);
      setInput("");
      setSuccess(`Alias updated to "${data.alias}"`);

      // Auto-clear success message
      setTimeout(() => setSuccess(null), 4000);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="border border-white/10 bg-black/30 p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-1">
            Public Alias
          </p>
          {currentAlias ? (
            <p className="text-xl font-black text-white tracking-tight">{currentAlias}</p>
          ) : (
            <p className="text-sm font-bold text-slate-500 italic">No alias set</p>
          )}
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => {
              setShowHistory((prev) => !prev);
              setEditMode(false);
            }}
            className="text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-white border border-white/10 px-3 py-1.5 transition-colors"
            aria-expanded={showHistory}
            aria-controls="alias-history-panel"
          >
            History
          </button>
          <button
            onClick={() => {
              setEditMode((prev) => !prev);
              setShowHistory(false);
              setError(null);
              setInput(currentAlias ?? "");
            }}
            className="text-xs font-bold uppercase tracking-widest text-white bg-white/10 hover:bg-white/20 border border-white/20 px-3 py-1.5 transition-colors"
          >
            {editMode ? "Cancel" : currentAlias ? "Change" : "Set Alias"}
          </button>
        </div>
      </div>

      {/* Success banner */}
      {success && (
        <div
          className="text-xs font-bold text-lime-400 border border-lime-400/20 bg-lime-900/20 px-3 py-2"
          role="status"
          aria-live="polite"
        >
          ✓ {success}
        </div>
      )}

      {/* Edit form */}
      {editMode && (
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label
              htmlFor="alias-input"
              className="block text-xs font-bold uppercase tracking-widest text-slate-400 mb-1.5"
            >
              New Alias
            </label>
            <input
              id="alias-input"
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="e.g. ShadowWatcher"
              minLength={3}
              maxLength={32}
              pattern="^[a-zA-Z0-9_-]+$"
              required
              disabled={submitting}
              className="w-full bg-black border border-white/20 text-white font-mono text-sm px-3 py-2 focus:outline-none focus:border-primary disabled:opacity-50"
              aria-describedby={error ? "alias-error" : "alias-hint"}
            />
            <p id="alias-hint" className="text-xs text-slate-500 mt-1">
              3–32 chars, letters / numbers / _ / - only. Wallet address is never shown publicly.
            </p>
          </div>

          {error && (
            <p
              id="alias-error"
              className="text-xs text-red-400 font-bold"
              role="alert"
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || input.trim().length < 3}
            className="w-full py-2.5 font-black uppercase tracking-widest text-sm border-2 border-primary text-primary hover:bg-primary hover:text-black transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? "Saving…" : "Save Alias"}
          </button>
        </form>
      )}

      {/* History panel */}
      {showHistory && (
        <div id="alias-history-panel" className="space-y-2">
          <p className="text-xs font-bold uppercase tracking-widest text-slate-400">
            Rotation History
          </p>
          {history.length === 0 ? (
            <p className="text-xs text-slate-500 italic">No previous aliases.</p>
          ) : (
            <ul className="divide-y divide-white/5" aria-label="Alias history">
              {history.map((entry, idx) => (
                <li key={idx} className="flex items-center justify-between py-2">
                  <span className="font-mono text-sm text-white font-bold">
                    {entry.alias}
                  </span>
                  <div className="text-right">
                    {entry.retiredAt === null ? (
                      <span className="text-xs font-black text-lime-400 tracking-widest">
                        ACTIVE
                      </span>
                    ) : (
                      <span className="text-xs text-slate-500">
                        Retired {new Date(entry.retiredAt).toLocaleDateString()}
                      </span>
                    )}
                    <p className="text-xs text-slate-600">
                      Set {new Date(entry.setAt).toLocaleDateString()}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

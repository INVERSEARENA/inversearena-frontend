"use client";

import React, { useState, useCallback } from "react";

interface DeadLetterItem {
  id: string;
  kind: string;
  payoutId?: string;
  arenaId?: string;
  status: string;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: string;
  payload: Record<string, unknown>;
}

interface DeadLetterPanelProps {
  adminToken: string;
}

export function DeadLetterPanel({ adminToken }: DeadLetterPanelProps) {
  const [items, setItems] = useState<DeadLetterItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [filters, setFilters] = useState({ arenaId: "", errorClass: "" });
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` };

  const fetchItems = useCallback(async (nextCursor?: string) => {
    setLoading(true);
    setActionResult(null);
    setActionError(null);

    const params = new URLSearchParams({ limit: "25" });
    if (filters.arenaId) params.set("arenaId", filters.arenaId);
    if (filters.errorClass) params.set("errorClass", filters.errorClass);
    if (nextCursor) params.set("cursor", nextCursor);

    try {
      const res = await fetch(`/api/admin/dead-letters?${params.toString()}`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(data.items ?? []);
      setCursor(data.nextCursor ?? null);
    } catch (e: any) {
      setActionError(e.message);
    } finally {
      setLoading(false);
    }
  }, [filters, adminToken]);

  const requestToken = async (action: string, resourceId: string): Promise<string> => {
    const res = await fetch("/api/admin/tokens/request", {
      method: "POST",
      headers,
      body: JSON.stringify({ action, resourceId }),
    });
    if (!res.ok) throw new Error("Failed to request confirmation token");
    const data = await res.json();
    return data.token;
  };

  const handleRedrive = async (item: DeadLetterItem) => {
    setActionResult(null);
    setActionError(null);
    try {
      const token = await requestToken("redrive_dead_letter", item.id);
      const res = await fetch(`/api/admin/dead-letters/${item.id}/redrive`, {
        method: "POST",
        headers,
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message ?? "Re-drive failed");
      setActionResult(`Re-drive result for ${item.id}: ${data.status}`);
      await fetchItems();
    } catch (e: any) {
      setActionError(e.message);
    }
  };

  const handleResolve = async (item: DeadLetterItem, reason: string) => {
    setActionResult(null);
    setActionError(null);
    try {
      const token = await requestToken("mark_resolved_dead_letter", item.id);
      const res = await fetch(`/api/admin/dead-letters/${item.id}/resolve`, {
        method: "POST",
        headers,
        body: JSON.stringify({ token, reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message ?? "Resolve failed");
      setActionResult(`Resolved ${item.id}`);
      await fetchItems();
    } catch (e: any) {
      setActionError(e.message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-3 items-end flex-wrap">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Arena ID</label>
          <input
            className="border rounded px-2 py-1 text-sm w-48"
            placeholder="Filter by arena..."
            value={filters.arenaId}
            onChange={(e) => setFilters((f) => ({ ...f, arenaId: e.target.value }))}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Error Class</label>
          <input
            className="border rounded px-2 py-1 text-sm w-48"
            placeholder="e.g. retries_exhausted"
            value={filters.errorClass}
            onChange={(e) => setFilters((f) => ({ ...f, errorClass: e.target.value }))}
          />
        </div>
        <button
          onClick={() => fetchItems()}
          className="px-4 py-1.5 bg-gray-800 text-white text-sm rounded hover:bg-gray-700"
        >
          {loading ? "Loading..." : "Search"}
        </button>
      </div>

      {actionResult && (
        <div className="p-3 bg-green-100 border border-green-300 text-green-700 rounded text-sm">{actionResult}</div>
      )}
      {actionError && (
        <div className="p-3 bg-red-100 border border-red-300 text-red-700 rounded text-sm">{actionError}</div>
      )}

      {items.length === 0 && !loading && (
        <div className="text-gray-500 text-sm text-center py-8">
          No dead-lettered items found. Run a search to begin.
        </div>
      )}

      {items.map((item) => (
        <div
          key={item.id}
          className="p-4 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg space-y-2"
        >
          <div className="flex justify-between items-start">
            <div>
              <span className="font-mono text-xs text-gray-500">{item.id}</span>
              <div className="text-sm mt-0.5">
                <span className="font-medium">{item.kind}</span>
                {item.payoutId && <span className="ml-2 text-gray-500">payout: {item.payoutId}</span>}
                {item.arenaId && <span className="ml-2 text-gray-500">arena: {item.arenaId}</span>}
              </div>
            </div>
            <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">dead</span>
          </div>

          <div className="text-xs text-gray-500 space-y-0.5">
            <div>Attempts: {item.attempts}</div>
            <div>Last attempt: {new Date(item.lastAttemptAt).toLocaleString()}</div>
            {item.lastError && (
              <div className="text-red-600 font-mono bg-red-50 px-2 py-1 rounded mt-1">
                {item.lastError}
              </div>
            )}
          </div>

          <div className="flex gap-2 pt-1">
            <button
              onClick={() => handleRedrive(item)}
              className="px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs rounded"
            >
              Re-drive
            </button>
            <button
              onClick={() => {
                const reason = window.prompt("Enter reason for resolving without re-drive:");
                if (reason && reason.length >= 5) handleResolve(item, reason);
              }}
              className="px-3 py-1 bg-amber-600 hover:bg-amber-700 text-white text-xs rounded"
            >
              Mark Resolved
            </button>
          </div>
        </div>
      ))}

      {cursor && (
        <div className="text-center pt-2">
          <button
            onClick={() => fetchItems(cursor)}
            className="px-4 py-2 border rounded text-sm"
          >
            Load More
          </button>
        </div>
      )}
    </div>
  );
}

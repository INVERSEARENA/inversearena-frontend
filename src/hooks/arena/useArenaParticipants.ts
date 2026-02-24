"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type ParticipantStatus = "JOINING" | "READY";
export type ParticipantStatusFilter = "ALL" | ParticipantStatus;

export interface Participant {
  walletAddress: string;
  status: ParticipantStatus;
  joinedAt: number;
}

interface UseArenaParticipantsOptions {
  refreshInterval?: number;
  statusFilter?: ParticipantStatusFilter;
}

interface ParticipantsApiPayload {
  participants?: unknown;
  items?: unknown;
  quorumTarget?: unknown;
  requiredPlayers?: unknown;
}

const DEFAULT_REFRESH_INTERVAL = 5000;

function asNonNegativeInt(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeParticipantStatus(value: unknown): ParticipantStatus {
  return value === "READY" ? "READY" : "JOINING";
}

function normalizeJoinedAt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }

  return Date.now();
}

function normalizeParticipant(raw: unknown): Participant | null {
  if (!raw || typeof raw !== "object") return null;

  const candidate = raw as {
    walletAddress?: unknown;
    wallet?: unknown;
    walletId?: unknown;
    status?: unknown;
    joinedAt?: unknown;
    timestamp?: unknown;
  };

  const walletAddress =
    typeof candidate.walletAddress === "string"
      ? candidate.walletAddress
      : typeof candidate.wallet === "string"
        ? candidate.wallet
        : typeof candidate.walletId === "string"
          ? candidate.walletId
          : "";

  if (!walletAddress) return null;

  return {
    walletAddress,
    status: normalizeParticipantStatus(candidate.status),
    joinedAt: normalizeJoinedAt(candidate.joinedAt ?? candidate.timestamp),
  };
}

function normalizePayload(payload: unknown): {
  participants: Participant[];
  quorumTarget: number;
} {
  if (!payload || typeof payload !== "object") {
    return { participants: [], quorumTarget: 0 };
  }

  const data = payload as ParticipantsApiPayload;
  const rawList = Array.isArray(data.participants)
    ? data.participants
    : Array.isArray(data.items)
      ? data.items
      : [];

  const participants = rawList
    .map((item) => normalizeParticipant(item))
    .filter((participant): participant is Participant => participant !== null);

  const quorumTarget = asNonNegativeInt(
    typeof data.quorumTarget === "number"
      ? data.quorumTarget
      : data.requiredPlayers,
    0,
  );

  return { participants, quorumTarget };
}

export function useArenaParticipants(
  arenaId: string,
  options: UseArenaParticipantsOptions = {},
) {
  const refreshInterval = options.refreshInterval ?? DEFAULT_REFRESH_INTERVAL;
  const statusFilter = options.statusFilter ?? "ALL";

  const [allParticipants, setAllParticipants] = useState<Participant[]>([]);
  const [quorumTarget, setQuorumTarget] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchParticipants = useCallback(
    async (withLoading = false) => {
      if (!arenaId) {
        setAllParticipants([]);
        setQuorumTarget(0);
        setError("Arena id is required");
        setLoading(false);
        return;
      }

      try {
        if (withLoading) setLoading(true);

        const response = await fetch(
          `/api/arenas/${encodeURIComponent(arenaId)}/participants`,
          { cache: "no-store" },
        );

        if (!response.ok) {
          throw new Error(
            `Failed to fetch arena participants (${response.status})`,
          );
        }

        const rawPayload: unknown = await response.json();
        const normalized = normalizePayload(rawPayload);

        setAllParticipants(normalized.participants);
        setQuorumTarget(normalized.quorumTarget);
        setError(null);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to fetch arena participants",
        );
      } finally {
        if (withLoading) setLoading(false);
      }
    },
    [arenaId],
  );

  useEffect(() => {
    let cancelled = false;

    const initialFetch = async () => {
      if (cancelled) return;
      await fetchParticipants(true);
    };

    initialFetch();

    return () => {
      cancelled = true;
    };
  }, [fetchParticipants]);

  useEffect(() => {
    if (!arenaId) return;

    intervalRef.current = setInterval(() => {
      void fetchParticipants(false);
    }, Math.max(250, refreshInterval));

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [arenaId, fetchParticipants, refreshInterval]);

  const participants = useMemo(() => {
    if (statusFilter === "ALL") return allParticipants;
    return allParticipants.filter((participant) => participant.status === statusFilter);
  }, [allParticipants, statusFilter]);

  const quorumCount = useMemo(
    () => allParticipants.filter((participant) => participant.status === "READY").length,
    [allParticipants],
  );

  const quorumPercent = useMemo(() => {
    if (quorumTarget <= 0) return 0;
    return (quorumCount / quorumTarget) * 100;
  }, [quorumCount, quorumTarget]);

  const refetch = useCallback(async () => {
    await fetchParticipants(true);
  }, [fetchParticipants]);

  return {
    participants,
    quorumCount,
    quorumTarget,
    quorumPercent,
    loading,
    error,
    refetch,
  };
}

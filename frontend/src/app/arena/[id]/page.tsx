import { ArenaLobbyClient } from "@/features/arena-lobby/ArenaLobbyClient";

interface PageProps {
  params: Promise<{ id: string }>;
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

async function loadArenaLobbyData(arenaId: string) {
  const statsResponse = await fetch(`${API_BASE}/api/arenas/${arenaId}/stats`, {
    cache: "no-store",
  });

  if (statsResponse.status === 404) {
    return {
      notFound: true,
      stats: null,
      participants: [],
      nextCursor: null,
    };
  }

  if (!statsResponse.ok) {
    throw new Error(`Failed to load arena stats (${statsResponse.status})`);
  }

  const stats = await statsResponse.json();

  let participantsData = { items: [], nextCursor: null as number | null };

  try {
    const participantsResponse = await fetch(
      `${API_BASE}/api/arenas/${arenaId}/participants?limit=12&cursor=0`,
      { cache: "no-store" },
    );

    if (participantsResponse.ok) {
      participantsData = await participantsResponse.json();
    }
  } catch {
    participantsData = { items: [], nextCursor: null };
  }

  return {
    notFound: false,
    stats,
    participants: participantsData.items ?? [],
    nextCursor: participantsData.nextCursor ?? null,
  };
}

export default async function ArenaLobbyPage({ params }: PageProps) {
  const { id: arenaId } = await params;

  let lobbyData: Awaited<ReturnType<typeof loadArenaLobbyData>>;
  try {
    lobbyData = await loadArenaLobbyData(arenaId);
  } catch {
    lobbyData = {
      notFound: false,
      stats: null,
      participants: [],
      nextCursor: null,
    };
  }

  return (
    <ArenaLobbyClient
      arenaId={arenaId}
      initialStats={lobbyData.stats}
      initialParticipants={lobbyData.participants}
      initialNextCursor={lobbyData.nextCursor}
      notFound={lobbyData.notFound}
    />
  );
}

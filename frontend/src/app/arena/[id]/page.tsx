import { ArenaLobbyClient } from "@/features/arena-lobby/ArenaLobbyClient";

interface PageProps {
  params: { id: string };
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
  const { id: arenaId } = params;

  try {
    const { notFound, stats, participants, nextCursor } =
      await loadArenaLobbyData(arenaId);

    return (
      <ArenaLobbyClient
        arenaId={arenaId}
        initialStats={stats}
        initialParticipants={participants}
        initialNextCursor={nextCursor}
        notFound={notFound}
      />
    );
  } catch {
    return (
      <ArenaLobbyClient
        arenaId={arenaId}
        initialStats={null}
        initialParticipants={[]}
        initialNextCursor={null}
        notFound={false}
      />
    );
  }
}

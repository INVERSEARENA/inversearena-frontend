import { ArenaLobbyClient } from "@/features/arena-lobby/components/ArenaLobbyClient";

interface PageProps {
  params: Promise<{ id: string }>;
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

async function loadArenaLobbyData(arenaId: string) {
  const [statsResponse, participantsResponse] = await Promise.all([
    fetch(`${API_BASE}/api/arenas/${arenaId}/stats`, {
      next: { revalidate: 15, tags: [`arena:${arenaId}:stats`] },
    }),
    fetch(`${API_BASE}/api/arenas/${arenaId}/participants?limit=12&cursor=0`, {
      next: { revalidate: 5, tags: [`arena:${arenaId}:participants`] },
    }),
  ]);

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

  const participantsData = participantsResponse.ok
    ? await participantsResponse.json()
    : { items: [], nextCursor: null as number | null };

  return {
    notFound: false,
    stats,
    participants: participantsData.items ?? [],
    nextCursor: participantsData.nextCursor ?? null,
  };
}

export default async function ArenaLobbyPage({ params }: PageProps) {
  const { id: arenaId } = await params;

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

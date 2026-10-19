import { ImageResponse } from "next/og";

export const runtime = "edge";
export const revalidate = 60;
export const alt = "Inverse Arena lobby";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function OpenGraphImage({ params }: PageProps) {
  const { id } = await params;
  const api = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
  let stats: { playerCount?: number; status?: string; prizePool?: number } = {};

  try {
    const response = await fetch(
      api + "/api/arenas/" + encodeURIComponent(id) + "/stats",
      { next: { revalidate: 60 } },
    );
    if (response.ok) stats = await response.json();
  } catch {
    // The image still renders a safe fallback when the backend is unavailable.
  }

  return new ImageResponse(
    (
      <div
        style={{
          background: "#071122",
          color: "white",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px",
          width: "100%",
          height: "100%",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", fontSize: 28, color: "#37ff1c" }}>
          INVERSE ARENA
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", fontSize: 58, fontWeight: 800 }}>
            Arena {id.slice(0, 12)}
          </div>
          <div style={{ display: "flex", fontSize: 28, color: "#b8c4d6" }}>
            {stats.status ?? "Live arena"} � {stats.playerCount ?? 0} players
          </div>
          <div style={{ display: "flex", fontSize: 34, color: "#37ff1c" }}>
            Prize pool: {stats.prizePool ?? " "}
          </div>
        </div>
        <div style={{ display: "flex", fontSize: 22, color: "#9aa8bd" }}>
          Verified arena state
        </div>
      </div>
    ),
    { ...size },
  );
}

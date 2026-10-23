import { ImageResponse } from "next/og";

export const runtime = "edge";
export const revalidate = 300;
export const alt = "Inverse Arena result";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function OpenGraphImage({ params }: PageProps) {
  const { id } = await params;
  const api = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
  let stats: { winner?: string; prizePool?: number; status?: string } = {};

  try {
    const response = await fetch(
      api + "/api/arenas/" + encodeURIComponent(id) + "/stats",
      { next: { revalidate: 300 } },
    );
    if (response.ok) stats = await response.json();
  } catch {
    // Settled links remain shareable even if the backend is temporarily down.
  }

  const winner = stats.winner
    ? stats.winner.slice(0, 6) + "..." + stats.winner.slice(-4)
    : "Result unavailable";

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
        <div style={{ display: "flex", fontSize: 28, color: "#ff0a54" }}>
          INVERSE ARENA � RESULT
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", fontSize: 58, fontWeight: 800 }}>
            Arena {id.slice(0, 12)}
          </div>
          <div style={{ display: "flex", fontSize: 32, color: "#37ff1c" }}>
            Winner: {winner}
          </div>
          <div style={{ display: "flex", fontSize: 30 }}>
            Prize pool: {stats.prizePool ?? " "} � {stats.status ?? "Settled"}
          </div>
        </div>
        <div style={{ display: "flex", fontSize: 22, color: "#9aa8bd" }}>
          Verified result preview
        </div>
      </div>
    ),
    { ...size },
  );
}

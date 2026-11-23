import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Player Profile - Inverse Arena";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

interface Props {
  params: Promise<{ aliasOrAddress: string }>;
}

export default async function Image({ params }: Props) {
  const { aliasOrAddress } = await params;
  const isAddress = aliasOrAddress.startsWith("G") && aliasOrAddress.length === 56;
  const displayTitle = isAddress
    ? `${aliasOrAddress.slice(0, 4)}...${aliasOrAddress.slice(-4)}`
    : `@${aliasOrAddress}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "60px",
          backgroundColor: "#080c14",
          backgroundImage: "radial-gradient(circle at 25px 25px, #1a2333 2%, transparent 0%), radial-gradient(circle at 75px 75px, #1a2333 2%, transparent 0%)",
          backgroundSize: "100px 100px",
          color: "#ffffff",
          fontFamily: "monospace",
          border: "12px solid #1c2739",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            <div
              style={{
                width: "48px",
                height: "48px",
                borderRadius: "8px",
                backgroundColor: "#FF007A",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "24px",
                fontWeight: "bold",
              }}
            >
              IA
            </div>
            <span style={{ fontSize: "28px", letterSpacing: "4px", color: "#8b949e", fontWeight: "bold" }}>
              INVERSE ARENA
            </span>
          </div>
          <div
            style={{
              padding: "8px 24px",
              borderRadius: "4px",
              border: "2px solid #37FF1C",
              color: "#37FF1C",
              fontSize: "18px",
              letterSpacing: "2px",
              fontWeight: "bold",
            }}
          >
            VERIFIED PLAYER PROFILE
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <div style={{ fontSize: "64px", fontWeight: "bold", color: "#FF007A", letterSpacing: "2px" }}>
            {displayTitle}
          </div>
          <div style={{ fontSize: "22px", color: "#8b949e", letterSpacing: "1px" }}>
            Stellar Soroban Sovereign Arena Competitor
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "32px",
            backgroundColor: "#0d1b2a",
            borderRadius: "8px",
            border: "1px solid #1c2739",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: "16px", color: "#8b949e", letterSpacing: "2px" }}>STATUS</span>
            <span style={{ fontSize: "32px", fontWeight: "bold", color: "#37FF1C" }}>ACTIVE</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: "16px", color: "#8b949e", letterSpacing: "2px" }}>SURVIVAL TIER</span>
            <span style={{ fontSize: "32px", fontWeight: "bold", color: "#ffffff" }}>CYBER ELITE</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: "16px", color: "#8b949e", letterSpacing: "2px" }}>NETWORK</span>
            <span style={{ fontSize: "32px", fontWeight: "bold", color: "#00d2ff" }}>STELLAR</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: "16px", color: "#8b949e", letterSpacing: "2px" }}>PROTOCOL</span>
            <span style={{ fontSize: "32px", fontWeight: "bold", color: "#FF007A" }}>v2.0</span>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
    },
  );
}

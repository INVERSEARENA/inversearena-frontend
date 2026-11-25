import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { PublicProfileView, type PublicProfileData } from "./PublicProfileView";

export const revalidate = 60; // Cache for 60 seconds

interface PageProps {
  params: Promise<{ aliasOrAddress: string }>;
}

async function getProfile(aliasOrAddress: string): Promise<PublicProfileData | null> {
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
  try {
    const res = await fetch(`${apiBase}/api/users/public/${encodeURIComponent(aliasOrAddress)}`, {
      next: { revalidate: 60 },
    });

    if (res.status === 404) return null;
    if (!res.ok) {
      // If backend is unreachable during static build or test, fallback gracefully for Stellar address
      if (/^G[A-Z2-7]{55}$/i.test(aliasOrAddress)) {
        return {
          address: aliasOrAddress,
          alias: null,
          level: 1,
          joinedAt: new Date().toISOString(),
          stats: {
            gamesPlayed: 0,
            gamesWon: 0,
            totalYieldEarned: "0.00",
            currentRank: null,
            winRate: 0,
          },
          achievements: [],
          recentSettledArenas: [],
          privacy: { hideHistory: false, hideFromSearch: false },
          isUnknown: true,
        };
      }
      return null;
    }

    return (await res.json()) as PublicProfileData;
  } catch {
    if (/^G[A-Z2-7]{55}$/i.test(aliasOrAddress)) {
      return {
        address: aliasOrAddress,
        alias: null,
        level: 1,
        joinedAt: new Date().toISOString(),
        stats: {
          gamesPlayed: 0,
          gamesWon: 0,
          totalYieldEarned: "0.00",
          currentRank: null,
          winRate: 0,
        },
        achievements: [],
        recentSettledArenas: [],
        privacy: { hideHistory: false, hideFromSearch: false },
        isUnknown: true,
      };
    }
    return null;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { aliasOrAddress } = await params;
  const profile = await getProfile(aliasOrAddress);

  if (!profile) {
    return {
      title: "Player Not Found | Inverse Arena",
      description: "No player profile found for this address or alias.",
    };
  }

  const displayName = profile.alias
    ? `@${profile.alias}`
    : `${profile.address.slice(0, 4)}...${profile.address.slice(-4)}`;

  const title = `${displayName} — Player Profile | Inverse Arena`;
  const description = `Level ${profile.level} Arena Competitor with ${profile.stats.gamesWon} wins and ${profile.stats.totalYieldEarned} USDC total yield.`;

  const ogImageUrl = `/p/${encodeURIComponent(aliasOrAddress)}/opengraph-image`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "profile",
      images: [
        {
          url: ogImageUrl,
          width: 1200,
          height: 630,
          alt: `${displayName} Inverse Arena Profile`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogImageUrl],
    },
    robots: profile.privacy?.hideFromSearch
      ? { index: false, follow: false }
      : { index: true, follow: true },
  };
}

export default async function PublicProfilePage({ params }: PageProps) {
  const { aliasOrAddress } = await params;
  const profile = await getProfile(aliasOrAddress);

  if (!profile) {
    notFound();
  }

  // Handle alias change redirect
  if ((profile as any).redirect && (profile as any).canonicalAlias) {
    redirect(`/p/${encodeURIComponent((profile as any).canonicalAlias)}`);
  }

  return (
    <div className="min-h-screen bg-[#040810] text-white py-8">
      <PublicProfileView profile={profile} />
    </div>
  );
}

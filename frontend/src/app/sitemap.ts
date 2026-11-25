import type { MetadataRoute } from "next";

/** Public site origin; override per environment via NEXT_PUBLIC_SITE_URL. */
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") || "https://app.inversearena.io";

/**
 * Dynamic sitemap (#699). Lists only publicly indexable routes — authenticated
 * dashboard and in-game arena views are excluded here and in robots.txt so they
 * aren't crawled.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [
    { url: `${SITE_URL}/`, lastModified, changeFrequency: "daily", priority: 1 },
    { url: `${SITE_URL}/leaderboard`, lastModified, changeFrequency: "hourly", priority: 0.8 },
  ];
}

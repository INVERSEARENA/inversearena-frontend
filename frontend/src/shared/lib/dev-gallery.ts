/**
 * Dev-gallery gate (#1645).
 *
 * The component gallery and the old demo routes live under `/dev`. In a
 * production build (`NODE_ENV=production`) every `/dev` path is a hard 404,
 * and `src/proxy.ts` short-circuits them before they reach the app router so
 * they are not crawlable and not part of the production route surface.
 *
 * Set `NEXT_PUBLIC_ENABLE_DEV_GALLERY=1` on a production build to open the
 * gallery (useful for staging visual reviews) — leave it unset in real deploys.
 */
export function isDevGalleryEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" ||
    process.env.NEXT_PUBLIC_ENABLE_DEV_GALLERY === "1"
  );
}

/** True for any request path owned by the gallery. */
export function isDevGalleryPath(pathname: string): boolean {
  return pathname === "/dev" || pathname.startsWith("/dev/");
}

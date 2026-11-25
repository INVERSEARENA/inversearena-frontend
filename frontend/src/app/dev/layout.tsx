import { notFound } from "next/navigation";
import { isDevGalleryEnabled } from "@/shared/lib/dev-gallery";

/**
 * Dev-only gallery layout (#1645). Every route under `/dev` is gated here;
 * `src/proxy.ts` also 404s these paths in production before they reach the
 * router, so demo pages are absent from the production route surface.
 */
export default function DevGalleryLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!isDevGalleryEnabled()) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-[#080b14] text-[#e2e8f0]">
      <header className="border-b border-white/10 px-6 py-4">
        <p className="text-xs uppercase tracking-[0.2em] text-[#63b3ed]">
          Dev gallery
        </p>
        <h1 className="text-xl font-bold">Component states</h1>
        <p className="mt-1 text-sm text-white/60">
          Local/staging only. Never part of the production route surface (#1645).
        </p>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}

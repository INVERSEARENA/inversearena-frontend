import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Offline — Inverse Arena",
  description: "You are offline.",
};

/**
 * Offline fallback page (#691). Served by the service worker when a navigation
 * request fails (e.g. a network drop mid-round), so players get clear context
 * about the connection instead of the browser's default error page.
 */
export default function OfflinePage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="w-10 h-10 bg-neon-pink" aria-hidden="true" />
      <h1 className="font-pixel text-sm text-white tracking-wider">YOU&apos;RE OFFLINE</h1>
      <p className="max-w-sm text-sm text-white/60 font-mono">
        Inverse Arena can&apos;t reach the network right now. Your game state is safe
        on-chain — reconnect and reload to continue.
      </p>
      <p className="text-[10px] text-white/40 font-mono uppercase tracking-[0.2em]">
        Waiting for connection…
      </p>
    </main>
  );
}

/**
 * Share-card preview (#1645), migrated from `/arena-v2/share-test` into the
 * dev-only gallery.
 */
export default function ShareTestPage() {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">Share card preview</h2>
      <div className="mx-auto max-w-sm rounded-2xl border border-white/10 bg-gradient-to-b from-[#0f1729] to-[#080b14] p-6">
        <p className="text-xs uppercase tracking-[0.2em] text-[#63b3ed]">
          Inverse Arena
        </p>
        <p className="mt-3 text-xl font-bold">I just won the minority side.</p>
        <p className="mt-2 text-sm text-white/60">
          Arena #842 · 100 players · 50,000 XLM pool
        </p>
        <div className="mt-6 flex gap-2">
          <button
            type="button"
            className="flex-1 rounded-lg bg-[#63b3ed] px-4 py-2 text-sm font-semibold text-[#080b14]"
          >
            Copy link
          </button>
          <button
            type="button"
            className="flex-1 rounded-lg border border-white/20 px-4 py-2 text-sm"
          >
            QR
          </button>
        </div>
      </div>
      <p className="text-sm text-white/50">
        Previously served from <code>/arena-v2/share-test</code>. Now only
        reachable under <code>/dev</code> in non-production builds (#1645).
      </p>
    </div>
  );
}

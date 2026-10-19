/**
 * Pool-success demo (#1645), migrated from `/pool-success-demo` into the
 * dev-only gallery so it no longer ships on the production route surface.
 */
export default function PoolSuccessDemoPage() {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">Pool success callout</h2>
      <div className="rounded-xl border border-[#3CFF1A]/40 bg-[#3CFF1A]/10 p-8 text-center">
        <p className="text-2xl font-bold text-[#3CFF1A]">Pool filled!</p>
        <p className="mt-2 text-white/70">
          100 / 100 players seated. The arena goes live at the next ledger close.
        </p>
        <button
          type="button"
          className="mt-6 rounded-lg bg-[#3CFF1A] px-6 py-2 font-semibold text-[#080b14]"
        >
          Share
        </button>
      </div>
      <p className="text-sm text-white/50">
        Previously served from <code>/pool-success-demo</code>. Now only reachable
        under <code>/dev</code> in non-production builds (#1645).
      </p>
    </div>
  );
}

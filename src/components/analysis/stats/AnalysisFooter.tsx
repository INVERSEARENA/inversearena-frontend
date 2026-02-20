export function AnalysisFooter() {
  return (
    <footer className="border-t-[3px] border-black px-4 py-3 md:px-6">
      <div className="grid grid-cols-1 gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-[#323843] md:grid-cols-3">
        <p>NETWORK: STELLAR MAINNET</p>
        <p className="md:text-center">CONTRACT ID: 0x_SOROB...</p>
        <p className="md:text-right">NODE HEALTH: 100%</p>
      </div>
    </footer>
  );
}


interface TotalYieldPotProps {
  amount: number;
  apr: number;
}

export function TotalYieldPot({ amount, apr }: TotalYieldPotProps) {
  const formatAmount = (num: number) => {
    const [whole, decimal] = num.toFixed(2).split(".");
    return { whole: Number(whole).toLocaleString(), decimal };
  };

  const { whole, decimal } = formatAmount(amount);

  return (
    <div className="bg-white border border-zinc-300 p-6">
      <p className="font-pixel text-[8px] tracking-[0.2em] text-zinc-500 uppercase mb-3">
        Total RWA Yield Pot
      </p>

      <div className="flex items-baseline mb-4">
        <span className="font-pixel text-3xl md:text-4xl text-black">
          ${whole}.
        </span>
        <span className="font-pixel text-lg text-black">{decimal}</span>
      </div>

      <div className="flex items-center gap-3">
        <span className="bg-neon-green px-3 py-1 font-pixel text-[8px] text-black">
          +{apr}% APR
        </span>
        <span className="font-pixel text-[8px] text-zinc-400 tracking-wider">
          ORACLE VERIFIED
        </span>
      </div>
    </div>
  );
}

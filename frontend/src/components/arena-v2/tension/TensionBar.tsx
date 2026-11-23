"use client";

interface TensionBarProps {
  headsPercentage: number;
  tailsPercentage: number;
}

export function TensionBar({ headsPercentage, tailsPercentage }: TensionBarProps) {
  return (
    <div className="bg-black border-[5px] border-[#101d2c] p-6 shadow-[10px_10px_0px_#000]">
      <div className="flex justify-between items-end mb-4 px-2">
        <div className="text-left">
          <p className="text-[11px] text-[#3CFF1A] font-bold tracking-[0.2em] uppercase">Heads Pop.</p>
          <p className="text-4xl font-[1000] italic leading-none">{headsPercentage}%</p>
        </div>
        
        <div className="text-center pb-1">
          <p className="text-[10px] text-gray-600 tracking-[0.5em] uppercase mb-1">Population Tension</p>
          <div className="flex justify-center gap-2">
            <span className="text-[#3CFF1A] text-2xl font-bold">⚡</span>
            <span className="text-[#FF0A54] text-2xl font-bold">⚡</span>
          </div>
        </div>

        <div className="text-right">
          <p className="text-[11px] text-[#FF0A54] font-bold tracking-[0.2em] uppercase">Tails Pop.</p>
          <p className="text-4xl font-[1000] italic leading-none">{tailsPercentage}%</p>
        </div>
      </div>

      <div className="relative h-12 flex bg-black border-2 border-black overflow-hidden outline outline-2 outline-black">
        <div className="h-full bg-[#3CFF1A]" style={{ width: `${headsPercentage}%` }} />
        <div className="h-full bg-[#FF0A54]" style={{ width: `${tailsPercentage}%` }} />
        <div className="absolute left-1/2 top-0 bottom-0 -translate-x-1/2 bg-black border-x-2 border-white/20 -skew-x-[25deg] px-10 flex items-center h-full">
          <span className="skew-x-[25deg] text-sm italic font-[1000] text-white">VS</span>
        </div>
      </div>
    </div>
  );
}
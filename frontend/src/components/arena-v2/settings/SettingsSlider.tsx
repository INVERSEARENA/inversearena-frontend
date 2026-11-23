interface SettingsSliderProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
  segmented?: boolean;
}

export function SettingsSlider({
  label,
  value,
  min = 0,
  max = 100,
  onChange,
  segmented = false,
}: SettingsSliderProps) {
  const totalSegments = 10;
  const progress = ((value - min) / (max - min)) * 100;
  const filledSegments = Math.round((progress / 100) * totalSegments);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="font-pixel text-[10px] uppercase tracking-[0.14em] text-[#b6c5e2]">{label}</label>
        <span className="font-pixel text-3xl leading-none text-[#39ff14]">{value}%</span>
      </div>

      {segmented ? (
        <div className="grid grid-cols-10 gap-0.5 border-2 border-black bg-[#05070d] p-1">
          {Array.from({ length: totalSegments }).map((_, index) => (
            <div
              key={`${label}-segment-${index}`}
              className={`h-6 ${index < filledSegments ? "bg-[#39ff14]" : "bg-[#0e1425]"}`}
            />
          ))}
        </div>
      ) : (
        <div className="border-2 border-black bg-[#05070d] p-1">
          <div className="h-5 w-full bg-[#0e1425]">
            <div className="h-full bg-[#39ff14]" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}

      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-2 w-full cursor-pointer appearance-none bg-transparent [&::-webkit-slider-runnable-track]:h-2 [&::-webkit-slider-runnable-track]:bg-[#0e1527] [&::-webkit-slider-thumb]:-mt-1 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-black [&::-webkit-slider-thumb]:bg-[#39ff14]"
      />
    </div>
  );
}

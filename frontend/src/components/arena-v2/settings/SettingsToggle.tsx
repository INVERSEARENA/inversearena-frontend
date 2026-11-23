interface SettingsToggleProps {
  label: string;
  enabled: boolean;
  onChange: (value: boolean) => void;
}

export function SettingsToggle({ label, enabled, onChange }: SettingsToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={() => onChange(!enabled)}
      className="flex h-12 w-full items-center justify-between border-2 border-black bg-[#05070d] px-3 transition hover:border-[#39ff14]"
    >
      <span className="font-pixel text-[10px] uppercase tracking-[0.12em] text-[#bfd0ef]">{label}</span>
      <span
        className={`relative inline-flex h-5 w-10 items-center rounded-full border border-black transition ${enabled ? "bg-[#39ff14]" : "bg-[#283758]"}`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 rounded-full bg-black shadow transition ${enabled ? "translate-x-5" : "translate-x-1"}`}
        />
      </span>
    </button>
  );
}

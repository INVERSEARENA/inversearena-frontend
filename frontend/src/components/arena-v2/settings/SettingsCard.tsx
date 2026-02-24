import { type ReactNode } from "react";

interface SettingsCardProps {
  title: string;
  children: ReactNode;
  className?: string;
}

export function SettingsCard({ title, children, className = "" }: SettingsCardProps) {
  return (
    <section className={`border-2 border-[#0b1734] bg-[#131f3b] p-5 shadow-[0_0_0_1px_rgba(28,255,92,0.05)] ${className}`}>
      <header className="mb-5 flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full bg-[#33ff2f] shadow-[0_0_12px_rgba(51,255,47,0.8)]" />
        <h2 className="font-pixel text-sm uppercase tracking-[0.14em] text-white/80">{title}</h2>
      </header>
      {children}
    </section>
  );
}

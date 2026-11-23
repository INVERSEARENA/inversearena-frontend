import { type ReactNode } from "react";

interface SettingsCardProps {
  title: string;
  children: ReactNode;
  className?: string;
}

export function SettingsCard({ title, children, className = "" }: SettingsCardProps) {
  return (
    <section className={`border-2 border-[#04112d] bg-[#142443] p-5 shadow-[0_0_0_1px_rgba(5,12,30,0.8)] ${className}`}>
      <header className="mb-5 flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full bg-[#39ff14] shadow-[0_0_10px_rgba(57,255,20,0.8)]" />
        <h2 className="font-pixel text-sm uppercase tracking-[0.14em] text-[#c7d3ec]">{title}</h2>
      </header>
      {children}
    </section>
  );
}

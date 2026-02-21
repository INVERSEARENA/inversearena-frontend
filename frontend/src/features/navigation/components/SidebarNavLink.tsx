"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { NavItem } from "../navItems";

import type { ReactNode } from "react";

export function SidebarNavLink({
  href,
  label,
  icon,
}: NavItem & { icon: ReactNode }) {
  const pathname = usePathname();
  const isActive = pathname === href;

  return (
    <Link
      href={href}
      className={[
        "flex w-full items-center gap-3 rounded-r-sm py-3 pl-3 pr-4 text-sm font-semibold tracking-wide transition-all",
        isActive
          ? "border-l-2 border-[#39ff14] bg-white/5 text-[#39ff14]"
          : "border-l-2 border-transparent text-zinc-400 hover:bg-white/5 hover:text-white",
      ].join(" ")}
    >
      <span className="shrink-0">{icon}</span>
      <span>{label}</span>
    </Link>
  );
}

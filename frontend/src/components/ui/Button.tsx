import type { ButtonHTMLAttributes } from "react";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "none";
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonProps) {
  const base =
    "inline-flex items-center justify-center rounded-full px-5 text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none";
  const styles =
    variant === "primary"
      ? "h-12 bg-black text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
      : variant === "secondary"
      ? "h-12 border border-black/10 hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
      : "";

  return <button className={`${base} ${styles} ${className}`} {...props} />;
}


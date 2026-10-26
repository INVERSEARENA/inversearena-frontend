"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { LOCALES, LOCALE_COOKIE, type Locale } from "@/i18n/config";

/**
 * Explicit locale switcher (#1575). Writes the `NEXT_LOCALE` cookie (the
 * single source of truth the server renders from) and refreshes the route
 * so server components re-render with the new catalog — this avoids any
 * client-only translation drift.
 */
export function LocaleSwitcher({ className }: { className?: string }) {
  const t = useTranslations("locale");
  const locale = useLocale();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const onChange = (next: string) => {
    if (next === locale) return;
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    startTransition(() => {
      router.refresh();
    });
  };

  return (
    <label
      className={`flex items-center gap-2 text-[10px] font-medium uppercase tracking-widest text-zinc-400 ${className ?? ""}`}
    >
      <span className="sr-only">{t("label")}</span>
      <span aria-hidden="true">🌐</span>
      <select
        value={locale}
        onChange={(e) => onChange(e.target.value)}
        disabled={isPending}
        className="bg-transparent border border-white/10 text-zinc-300 px-1 py-0.5 text-[10px] uppercase focus:border-neon-green focus:outline-none disabled:opacity-50"
        aria-label={t("label")}
        data-testid="locale-switcher"
      >
        {LOCALES.map((code: Locale) => (
          <option key={code} value={code} className="bg-black text-white">
            {t(code)}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * i18n runtime configuration (#1575).
 *
 * The app ships locale *detection* rather than locale *routing*: the active
 * locale is resolved server-side from the `NEXT_LOCALE` cookie (seeded from
 * `Accept-Language` by src/proxy.ts) so server and client always agree —
 * no hydration mismatches. The switcher writes the cookie and refreshes.
 */
export const LOCALES = ["en", "es"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** Cookie that persists the explicit user choice. */
export const LOCALE_COOKIE = "NEXT_LOCALE";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Best supported locale for a raw `Accept-Language` header value. */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const candidates = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag = "", ...params] = part.trim().split(";");
      const qParam = params.find((p) => p.trim().startsWith("q="));
      const q = qParam ? Number.parseFloat(qParam.trim().slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((c) => c.tag.length > 0)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of candidates) {
    const base = tag.split("-")[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

/**
 * Resolve the locale from the persisted cookie, falling back to
 * `Accept-Language` and finally the default. Used by the root layout and
 * `getRequestConfig` so both sides of the render agree.
 */
export function resolveLocale(
  cookieValue: string | null | undefined,
  acceptLanguage?: string | null,
): Locale {
  if (isLocale(cookieValue)) return cookieValue;
  return negotiateLocale(acceptLanguage);
}

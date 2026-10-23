import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  isLocale,
  resolveLocale,
} from "./config";

/**
 * next-intl server config (#1575). Locale comes from the same cookie the
 * client switcher writes; with no cookie we fall back to `Accept-Language`
 * then the default. Both paths run on the server, so `NextIntlClientProvider`
 * and `<html lang>` always receive the same value — no hydration drift.
 */
export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const cookieLocale = cookieStore.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(cookieLocale)
    ? cookieLocale
    : resolveLocale(null, headerStore.get("accept-language")) || DEFAULT_LOCALE;

  return {
    locale,
    messages: (await import(`./messages/${locale}.json`)).default,
  };
});

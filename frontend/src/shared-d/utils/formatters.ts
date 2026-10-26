/**
 * Locale-aware formatters for token amounts, bps rates, percentages,
 * countdowns and dates (#1575).
 *
 * All formatting goes through `Intl`, so separators, grouping and unit
 * names follow the active locale instead of hardcoded "en-US" templates.
 * Token amounts are BigInt-exact: stellar amounts carry 7 decimals and
 * values can exceed Number.MAX_SAFE_INTEGER, so the integer/fraction split
 * happens in BigInt space before any Intl call.
 */

export type FormatterLocale = string;

const DEFAULT_AMOUNT_DECIMALS = 7;

function assertValidLocale(locale: FormatterLocale): void {
  if (!locale || typeof locale !== "string") {
    throw new TypeError(`formatAmount: invalid locale ${String(locale)}`);
  }
}

/** Decimal separator for a locale, e.g. "." in en, "," in es/de. */
export function decimalSeparator(locale: FormatterLocale): string {
  const parts = new Intl.NumberFormat(locale).formatToParts(1.5);
  return parts.find((p) => p.type === "decimal")?.value ?? ".";
}

/** Grouping (thousands) separator for a locale, e.g. "," in en, "." in es. */
export function groupSeparator(locale: FormatterLocale): string {
  const parts = new Intl.NumberFormat(locale).formatToParts(10000);
  return parts.find((p) => p.type === "group")?.value ?? ",";
}

function splitBigInt(value: bigint, decimals: number): {
  negative: boolean;
  integer: string;
  fraction: string;
} {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  if (decimals <= 0) {
    return { negative, integer: abs.toString(), fraction: "" };
  }
  const base = 10n ** BigInt(decimals);
  const integer = (abs / base).toString();
  const fraction = (abs % base).toString().padStart(decimals, "0");
  return { negative, integer, fraction };
}

export interface FormatAmountOptions {
  /** Trailing zeros in the fraction are dropped when true (default true). */
  trimTrailingZeros?: boolean;
  /** Show the "+" sign for positive values (default false). */
  signDisplay?: "auto" | "always" | "never";
}

/**
 * Format a raw minor-unit amount (e.g. stroops with 7 decimals) as a
 * locale-grouped decimal string. Accepts `bigint` or a decimal string;
 * never routes through `Number`, so precision is exact for any magnitude.
 *
 * formatAmount(1_500_000_00n, 7, "en")   → "1.5"
 * formatAmount(1_500_000_00n, 7, "de")   → "1,5"
 * formatAmount(-250n, 0, "en")           → "-250"
 */
export function formatAmount(
  value: bigint | string | number,
  decimals: number = DEFAULT_AMOUNT_DECIMALS,
  locale: FormatterLocale = "en",
  options: FormatAmountOptions = {},
): string {
  assertValidLocale(locale);
  const { trimTrailingZeros = true, signDisplay = "auto" } = options;
  let amount: bigint;
  if (typeof value === "bigint") {
    amount = value;
  } else if (typeof value === "string") {
    amount = BigInt(value);
  } else {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(
        `formatAmount: pass a safe integer as bigint/string, got ${value}`,
      );
    }
    amount = BigInt(value);
  }

  const { negative, integer, fraction } = splitBigInt(amount, decimals);
  const groupedInteger = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(BigInt(integer));

  let frac = fraction;
  if (trimTrailingZeros) {
    frac = frac.replace(/0+$/, "");
  }

  const decSep = decimalSeparator(locale);
  const body = frac.length > 0 ? `${groupedInteger}${decSep}${frac}` : groupedInteger;

  const absIsZero = amount === 0n;
  const showPlus = signDisplay === "always" && !negative && !absIsZero;
  if (negative) return `-${body}`;
  if (showPlus) return `+${body}`;
  return body;
}

/**
 * Format a basis-points rate as a locale percent string:
 * 500 bps → "5.00%" (en), "5,00 %" (es), "5,00 %" (de).
 */
export function formatBps(
  bps: number | bigint,
  locale: FormatterLocale = "en",
  fractionDigits = 2,
): string {
  assertValidLocale(locale);
  const asNumber = typeof bps === "bigint" ? Number(bps) : bps;
  if (!Number.isFinite(asNumber)) {
    throw new TypeError(`formatBps: invalid bps ${String(bps)}`);
  }
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(asNumber / 10_000);
}

/**
 * Format a fraction (0.0245) as a locale percent string:
 * 0.0245 → "+2.45%" (en). Pass `signDisplay: "always"` to force the sign.
 */
export function formatPercent(
  fraction: number,
  locale: FormatterLocale = "en",
  fractionDigits = 2,
  signDisplay: "auto" | "always" | "never" = "auto",
): string {
  assertValidLocale(locale);
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
    signDisplay,
  }).format(fraction);
}

type CountdownUnit = NonNullable<Intl.NumberFormatOptions["unit"]>;

const COUNTDOWN_UNITS: ReadonlyArray<CountdownUnit> = [
  "day",
  "hour",
  "minute",
  "second",
];

/**
 * Format a duration in seconds as a compact locale countdown, e.g.
 * 3725 → "1h 2m 5s" (en), "1 h 2 m 5 s" (es). Zero-valued leading units
 * are skipped; a fully-zero duration renders as "0s". Unit names come from
 * `Intl.NumberFormat` unit notation, so they follow the locale.
 */
export function formatCountdown(
  totalSeconds: number | bigint,
  locale: FormatterLocale = "en",
): string {
  assertValidLocale(locale);
  let remaining = Number(totalSeconds);
  if (!Number.isFinite(remaining) || remaining < 0) {
    throw new TypeError(`formatCountdown: invalid seconds ${String(totalSeconds)}`);
  }
  remaining = Math.floor(remaining);

  const values: Record<string, number> = {
    day: Math.floor(remaining / 86_400),
    hour: Math.floor((remaining % 86_400) / 3_600),
    minute: Math.floor((remaining % 3_600) / 60),
    second: remaining % 60,
  };

  const parts: string[] = [];
  let seenNonZero = false;
  for (const unit of COUNTDOWN_UNITS) {
    const value = values[unit] ?? 0;
    if (value > 0) seenNonZero = true;
    if (!seenNonZero) continue;
    parts.push(
      new Intl.NumberFormat(locale, {
        style: "unit",
        unit,
        unitDisplay: "narrow",
      }).format(value),
    );
  }
  if (parts.length === 0) {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "second",
      unitDisplay: "narrow",
    }).format(0);
  }
  return parts.join(" ");
}

/** Locale date-time for a unix timestamp in seconds. */
export function formatTimestamp(
  unixSeconds: number | bigint,
  locale: FormatterLocale = "en",
): string {
  assertValidLocale(locale);
  const ms = Number(unixSeconds) * 1000;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}

/** Locale-aware whole-number grouping for scores/player counts. */
export function formatCount(
  value: number | bigint,
  locale: FormatterLocale = "en",
): string {
  assertValidLocale(locale);
  return new Intl.NumberFormat(locale).format(value);
}

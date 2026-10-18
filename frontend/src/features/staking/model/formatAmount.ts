/**
 * Exact minor-unit formatting for staking amounts (#1510).
 *
 * The backend sends exact integer minor-unit strings. Rendering must not go
 * through `Number`, so this formats with `BigInt` and only ever produces a
 * decimal string.
 */

export function formatMinorUnits(
  units: string | null,
  decimals: number,
  options: { trimTrailingZeros?: boolean } = {},
): string {
  if (units === null) return "—";
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error("decimals must be a non-negative integer");
  }

  let value: bigint;
  try {
    value = BigInt(units);
  } catch {
    return "—";
  }

  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const divisor = 10n ** BigInt(decimals);

  if (decimals === 0) {
    return `${negative ? "-" : ""}${magnitude.toString()}`;
  }

  const whole = magnitude / divisor;
  let frac = (magnitude % divisor).toString().padStart(decimals, "0");
  if (options.trimTrailingZeros) {
    frac = frac.replace(/0+$/, "");
  }
  const body = frac.length > 0 ? `${whole}.${frac}` : whole.toString();
  return `${negative ? "-" : ""}${body}`;
}

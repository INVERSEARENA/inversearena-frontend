import { z } from "zod";

export interface EnvVarSpec {
  /** Heading the variable is grouped under in `.env.example`. */
  section: string;
  description: string;
  /** Value written to `.env.example`. Give secrets one only if it is a safe local value. */
  example?: string;
  /** Behaviour when unset, for the docs. */
  default?: string;
  /** Boot fails when unset. */
  required?: boolean;
  /** Never logged or printed. */
  secret?: boolean;
  /** Validates the raw string when the variable is set. */
  schema: z.ZodType<string>;
}

export const text = z.string().min(1);
export const url = z.string().url("must be a URL");
export const int = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .regex(/^-?\d+$/, "must be an integer")
    .refine(
      (value) => !/^-?\d+$/.test(value) || (Number(value) >= min && Number(value) <= max),
      `must be between ${min} and ${max}`,
    );
export const flag = z.enum(["true", "false", "1", "0"], { message: 'must be "true" or "false"' });
export const decimal = (min: number, max = Number.MAX_VALUE) =>
  z
    .string()
    .regex(/^-?\d+(\.\d+)?$/, "must be a number")
    .refine(
      (value) => !/^-?\d+(\.\d+)?$/.test(value) || (Number(value) >= min && Number(value) <= max),
      `must be between ${min} and ${max}`,
    );
export const contractId = z.string().regex(/^C[A-Z2-7]{55}$/, "must be a Stellar contract id (C + 55 base32 chars)");
export const accountId = z.string().regex(/^G[A-Z2-7]{55}$/, "must be a Stellar account id (G + 55 base32 chars)");
export const secretSeed = z.string().regex(/^S[A-Z2-7]{55}$/, "must be a Stellar secret seed (S + 55 base32 chars)");
export const isoTimestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO-8601 timestamp");
export const kid = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "must be 1-64 of [A-Za-z0-9._-]");
export const csv = (item: z.ZodType<string>, label: string) =>
  z.string().refine(
    (value) =>
      value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .every((part) => item.safeParse(part).success),
    `must be a comma-separated list of ${label}`,
  );

export function rateLimit<N extends string>(routeClass: string, name: N, points: number, windowSeconds: number) {
  const specs = {} as Record<`RATE_LIMIT_${N}_POINTS` | `RATE_LIMIT_${N}_WINDOW_SECONDS`, EnvVarSpec>;
  specs[`RATE_LIMIT_${name}_POINTS` as const] = {
    section: "Rate limiting",
    description: `Requests allowed per window for ${routeClass} (packages/rate-limit).`,
    default: String(points),
    schema: int(1),
  };
  specs[`RATE_LIMIT_${name}_WINDOW_SECONDS` as const] = {
    section: "Rate limiting",
    description: `Window length in seconds for ${routeClass}.`,
    default: String(windowSeconds),
    schema: int(1),
  };
  return specs;
}

/** The overlap-window variables secretKeyring.ts reads for a rotating secret. */
export function rotation<P extends string>(prefix: P, section: string) {
  const specs = {} as Record<`${P}_KID` | `${P}_PREVIOUS` | `${P}_PREVIOUS_KID` | `${P}_PREVIOUS_EXPIRES_AT`, EnvVarSpec>;
  specs[`${prefix}_KID` as const] = {
    section,
    description: `Optional explicit key id for ${prefix}. Derived from a fingerprint when unset.`,
    schema: kid,
  };
  specs[`${prefix}_PREVIOUS` as const] = {
    section,
    description: `Previous ${prefix}, accepted for verification only during a rotation overlap (#1456, docs/design/secret-rotation.md).`,
    secret: true,
    schema: text,
  };
  specs[`${prefix}_PREVIOUS_KID` as const] = {
    section,
    description: `Optional explicit key id for the previous ${prefix}.`,
    schema: kid,
  };
  specs[`${prefix}_PREVIOUS_EXPIRES_AT` as const] = {
    section,
    description: `End of the overlap window (ISO-8601, at most 30 days away). Required while ${prefix}_PREVIOUS is set.`,
    example: "2026-01-08T00:00:00Z",
    schema: isoTimestamp,
  };
  return specs;
}


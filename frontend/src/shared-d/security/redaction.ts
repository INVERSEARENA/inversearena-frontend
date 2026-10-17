/**
 * Shared secret redaction policy (#1531).
 * Applied at logger serialization, HTTP error responses, audit metadata, and Sentry boundaries.
 */

export const REDACTED = "[REDACTED]";

const JWT_LIKE =
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const STELLAR_SECRET = /S[A-Z2-7]{55}/g;
const RAW_XDR =
  /AAAA[A-Za-z0-9+/]{40,}={0,2}/g;
const AUTH_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "x-api-key",
  "x-webhook-signature",
]);

export type RedactionOptions = {
  /** Env-provided secrets to scrub verbatim (e.g. JWT_SECRET). */
  configuredSecrets?: string[];
  /** When true, replace uninspectable values instead of throwing. */
  failClosed?: boolean;
};

function scrubString(value: string, configuredSecrets: string[]): string {
  let out = value;
  for (const secret of configuredSecrets) {
    if (secret && out.includes(secret)) {
      out = out.split(secret).join(REDACTED);
    }
  }
  out = out.replace(JWT_LIKE, REDACTED);
  out = out.replace(STELLAR_SECRET, REDACTED);
  out = out.replace(RAW_XDR, REDACTED);
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively redact known credential patterns from arbitrary JSON-like payloads.
 * Transaction hashes (64-char hex) and public contract IDs (C… / G…) are preserved.
 */
export function redactSecrets(
  input: unknown,
  options: RedactionOptions = {},
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  const configuredSecrets = options.configuredSecrets ?? [];
  const failClosed = options.failClosed ?? true;

  if (input == null || typeof input === "number" || typeof input === "boolean") {
    return input;
  }

  if (typeof input === "string") {
    return scrubString(input, configuredSecrets);
  }

  if (typeof input === "bigint" || typeof input === "function" || typeof input === "symbol") {
    return failClosed ? REDACTED : input;
  }

  if (Array.isArray(input)) {
    return input.map((item) => redactSecrets(item, options, seen));
  }

  if (isPlainObject(input)) {
    if (seen.has(input)) {
      return failClosed ? REDACTED : "[Circular]";
    }
    seen.add(input);

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      const lowerKey = key.toLowerCase();
      if (
        AUTH_HEADER_NAMES.has(lowerKey) ||
        lowerKey.includes("token") ||
        lowerKey.includes("nonce") ||
        lowerKey.includes("signature") ||
        lowerKey.includes("password") ||
        lowerKey.includes("secret")
      ) {
        out[key] = REDACTED;
        continue;
      }
      out[key] = redactSecrets(value, options, seen);
    }
    return out;
  }

  return failClosed ? REDACTED : String(input);
}

/** Serialize and redact for logs / telemetry export boundaries. */
export function redactForExport(
  input: unknown,
  options: RedactionOptions = {},
): string {
  return JSON.stringify(redactSecrets(input, options));
}

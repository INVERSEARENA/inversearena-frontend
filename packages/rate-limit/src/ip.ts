import type { HeaderGetter } from "./types";

export const UNTRUSTED_CLIENT_BUCKET = "unknown";

export function getTrustedProxyCount(): number {
  const raw = process.env.TRUSTED_PROXY_COUNT;
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

function getHeaderValue(headers: HeaderGetter, name: string): string | null {
  if ("get" in headers && typeof headers.get === "function") {
    return headers.get(name);
  }
  const record = headers as Record<string, string | string[] | undefined>;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === lower) {
      if (Array.isArray(value)) return value.join(", ");
      if (typeof value === "string") return value;
      return null;
    }
  }
  return null;
}

/**
 * Resolve the client IP to bucket a rate-limit key on.
 *
 * `X-Forwarded-For` is only honoured when `trustedProxyCount > 0`: the right-most
 * `trustedProxyCount` entries are appended by our own infrastructure, so the real
 * remote client is at index `parts.length - trustedProxyCount`. Anything a caller
 * prepends lands further left and is safely ignored.
 *
 * When not behind a known proxy (trustedProxyCount === 0), callers share the
 * `UNTRUSTED_CLIENT_BUCKET` bucket ("unknown") to fail closed rather than trusting
 * a spoofable header.
 */
export function resolveClientIp(
  headers: HeaderGetter,
  trustedProxyCount: number = getTrustedProxyCount(),
  fallbackBucket: string = UNTRUSTED_CLIENT_BUCKET,
): string {
  if (trustedProxyCount <= 0) {
    return fallbackBucket;
  }

  const forwardedFor = getHeaderValue(headers, "x-forwarded-for");
  if (forwardedFor) {
    const parts = forwardedFor
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length >= trustedProxyCount) {
      const clientIp = parts[parts.length - trustedProxyCount];
      if (clientIp) return clientIp;
    }
  }

  const realIp = getHeaderValue(headers, "x-real-ip");
  if (realIp?.trim()) {
    return realIp.trim();
  }

  return fallbackBucket;
}

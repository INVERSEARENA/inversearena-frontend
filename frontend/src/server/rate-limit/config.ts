export type RouteRateLimitConfig = {
  keyPrefix: string;
  points: number;
  durationSeconds: number;
};

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

export const nonceRateLimitConfig: RouteRateLimitConfig = {
  keyPrefix: process.env.RATE_LIMIT_NONCE_PREFIX ?? "rl:auth:nonce",
  points: readPositiveInt("RATE_LIMIT_NONCE_POINTS", 5),
  durationSeconds: readPositiveInt("RATE_LIMIT_NONCE_WINDOW_SECONDS", 60),
};

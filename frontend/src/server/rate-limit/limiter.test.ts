import assert from "node:assert/strict";
import test from "node:test";

import type { RouteRateLimitConfig } from "./config.ts";
import { buildRateLimitRejection, consumeRateLimitByKey } from "./limiter.ts";

function createConfig(prefix: string, points: number, durationSeconds: number): RouteRateLimitConfig {
  return {
    keyPrefix: prefix,
    points,
    durationSeconds,
  };
}

test("blocks after threshold and reports retry delay", async () => {
  const config = createConfig("test:nonce:block", 2, 2);
  const key = "ip:127.0.0.1:wallet:test";

  const first = await consumeRateLimitByKey({ config, key });
  const second = await consumeRateLimitByKey({ config, key });
  const third = await consumeRateLimitByKey({ config, key });

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(third.allowed, false);
  assert.ok(third.retryAfterSeconds >= 1);
});

test("window reset allows requests again after duration", async () => {
  const config = createConfig("test:pools:reset", 1, 1);
  const key = "ip:127.0.0.1";

  const allowed = await consumeRateLimitByKey({ config, key });
  const blocked = await consumeRateLimitByKey({ config, key });
  assert.equal(allowed.allowed, true);
  assert.equal(blocked.allowed, false);

  await new Promise((resolve) => setTimeout(resolve, 1_200));

  const afterReset = await consumeRateLimitByKey({ config, key });
  assert.equal(afterReset.allowed, true);
});

test("returns 429 response with Retry-After when request is rate-limited", async () => {
  const config = createConfig("test:nonce:response", 1, 1);
  const request = {
    headers: new Headers({ "x-forwarded-for": "127.0.0.1" }),
  } as never;

  const first = await buildRateLimitRejection({ config, request });
  const second = await buildRateLimitRejection({ config, request });

  assert.equal(first, null);
  assert.ok(second);
  assert.equal(second.status, 429);
  const retryAfter = Number(second.headers.get("Retry-After") ?? "0");
  assert.ok(retryAfter >= 1);
});

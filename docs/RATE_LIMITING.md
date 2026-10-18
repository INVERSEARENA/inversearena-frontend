# Rate Limiting Architecture & Policy Specification

This document defines the unified rate-limiting architecture implemented across InverseArena backend and frontend runtimes via the `@inversearena/rate-limit` internal package (`packages/rate-limit`).

---

## 1. Motivation & Problem Statement

Previously, rate limiting was duplicated in:
- `frontend/src/server/rate-limit/limiter.ts` (Next.js route handlers)
- `backend/src/middleware/rateLimit.ts` (Express server)

This caused significant issues:
1. **Header Spoofing / IP Bypass**: Backend blindly trusted `req.headers["x-forwarded-for"].split(",")[0]`, allowing attackers to forge arbitrary client IPs and bypass rate limits entirely.
2. **Key Format Discrepancies**: Different key naming conventions and bucket structures prevented unified monitoring.
3. **Policy Drift**: Abuse policy tuning required changing multiple codebases in parallel.
4. **Redis Key Collisions**: If frontend and backend shared a Redis instance, key prefixes could collide or conflict.

---

## 2. Shared Module Architecture

The `@inversearena/rate-limit` workspace package provides:
- **`resolveClientIp`**: Deterministic, secure client IP resolution behind $N$ trusted proxies.
- **`DEFAULT_POLICY_TABLE` & `getRoutePolicy`**: Centralized route class policies with environment variable overrides.
- **`buildRateLimitKeys`**: Consistent key builders for single IP, combined IP + wallet, and dual-scope buckets.
- **`getRateLimiter` & `consumeRateLimitKeys`**: Redis-backed rate limiting with seamless in-memory fallback.
- **Adapters**:
  - `createExpressRateLimitMiddleware` for Express APIs.
  - `consumeNextRateLimit` and `buildNextRateLimitRejection` for Next.js route handlers.

---

## 3. Client IP Resolution & Security

### Algorithm

```typescript
resolveClientIp(headers, trustedProxyCount = getTrustedProxyCount(), fallbackBucket = "unknown")
```

1. If `trustedProxyCount === 0`:
   - The application does not sit behind a verified reverse proxy.
   - Headers like `X-Forwarded-For` and `X-Real-IP` are attacker-controlled.
   - Fails closed by bucketing all callers into the sentinel `"unknown"` bucket.
2. If `trustedProxyCount > 0`:
   - Inspect `X-Forwarded-For` by splitting entries on commas.
   - The rightmost `trustedProxyCount` entries were appended by trusted internal infrastructure (CDNs, ALBs, ingress).
   - The real remote client IP is at index `parts.length - trustedProxyCount`.
   - Any hops prepended by the caller on the left are ignored.
   - If `X-Forwarded-For` is missing or shorter than `trustedProxyCount`, falls back to `X-Real-IP` (if set by a trusted reverse proxy), or falls closed to `"unknown"`.

---

## 4. Policy Table

| Route Class | Default Points | Window Duration | Dual Scope | Key Prefix | Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `AUTH_NONCE` | 5 | 60s | No | `rl:auth:nonce` | Protects nonce generation against wallet enumeration / flooding |
| `AUTH_VERIFY` | 10 | 60s | Yes | `rl:auth:verify` | Protects cryptographic signature verification (independent IP & wallet budgets) |
| `AUTH_REFRESH` | 20 | 60s | No | `rl:auth:refresh` | Session token refresh endpoints |
| `POOLS_CREATE` | 3 | 60s | No | `rl:pools:create` | High-cost pool creation hitting Soroban RPC |
| `ARENAS_SYNC_PLAYERS` | 3 | 60s | No | `rl:arenas:sync-players` | Expensive RPC player state synchronization |
| `ARENAS_RESERVATION` | 10 | 60s | No | `rl:arenas:reservation` | Lobby reservation confirmation |
| `SIMULATIONS` | 5 | 60s | Yes | `rl:simulations` | CPU/RPC-heavy Soroban transaction simulation endpoints |
| `ADMIN_WALLET_ROLE` | 20 | 60s | No | `rl:admin:wallet-role` | Admin role mutations |

### Environment Variable Overrides
Each policy can be tuned in production via:
- `RATE_LIMIT_<NAME>_POINTS`
- `RATE_LIMIT_<NAME>_WINDOW_SECONDS`
- `RATE_LIMIT_<NAME>_PREFIX`

---

## 5. Redis Key Namespaces & Collision Avoidance

### Key Schema
```
[appNamespace:]<keyPrefix>:<scopeKey>
```

Examples:
- Standard IP limit: `rl:auth:nonce:ip:203.0.113.195`
- IP + Wallet limit: `rl:pools:create:ip:203.0.113.195:wallet:gbrpyh...`
- Dual-scope independent buckets:
  - `rl:auth:verify:ip:203.0.113.195`
  - `rl:auth:verify:wallet:gbrpyh...`

### Cross-App Isolation
When frontend and backend share a Redis cluster:
Set `RATE_LIMIT_APP_NAMESPACE` (e.g. `web` for frontend, `api` for backend) to prefix all keys:
- `web:rl:auth:nonce:ip:10.0.0.1`
- `api:rl:auth:nonce:ip:10.0.0.1`

This ensures zero key collisions while allowing centralized Redis utilization.

---

## 6. Runtime Compatibility

- **Node.js Runtime Required**: Both backend Express and Next.js route handlers utilizing `@inversearena/rate-limit` must run on the Node.js runtime (`runtime = "nodejs"` in Next.js). `ioredis` is not compatible with Vercel Edge / Cloudflare Workers runtimes.
- **Fail-Open Graceful Degradation**: If Redis is unreachable, `rate-limiter-flexible` automatically falls back to an in-memory insurance limiter without crashing user requests.

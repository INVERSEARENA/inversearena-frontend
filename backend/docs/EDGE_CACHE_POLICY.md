# Edge Cache Policy and Configuration Revalidation (#1626)

This document is the source of truth for **which backend responses a shared
cache may store**, and **how an on-chain configuration change invalidates the
caches that go stale as a result**.

## Principles

1. **Opt-in, not opt-out.** `privateNoStore()` is mounted globally in
   `backend/src/app.ts`. Every response is `Cache-Control: no-store` unless a
   route explicitly wraps itself in `publicCache(...)`. Nothing is cached by
   omission, so a new personalized endpoint cannot accidentally become
   shareable.
2. **Never cache personalized data publicly.** `publicCache` refuses to emit a
   shared directive when the request carries an `Authorization` header or a
   cookie (`requestIsPersonalized`). This is enforced in code, not in CDN
   configuration, because a CDN may be configured to ignore cookies.
3. **`stale-while-revalidate` over long `max-age`.** A short `max-age` keeps
   data reasonably fresh; the SWR window lets the edge absorb anonymous bursts
   while the origin refreshes in the background.

## Cache-Control table

| Endpoint | Method | Auth | `Cache-Control` | Rationale |
|---|---|---|---|---|
| `/api/stats/landing` | GET | public | `public, max-age=30, must-revalidate, stale-while-revalidate=300, stale-if-error=3600` | Aggregate landing feed; identical for every caller; rendered by ISR at most once/min. |
| `/api/config/protocol` | GET | public | `public, max-age=15, must-revalidate, stale-while-revalidate=120, stale-if-error=600` | Deployment config; only changes with the deployment. |
| `/api/config/compatibility` | GET | public | `public, max-age=15, must-revalidate, stale-while-revalidate=120, stale-if-error=600` | Versioned manifest; carries `configRevision` so clients never act on a stale one silently. |
| `/api/arenas` | GET | public | `public, max-age=30, must-revalidate, stale-while-revalidate=120` | Arena discovery list; changes infrequently. |
| `/api/arenas/:id/stats` | GET | public | `public, max-age=15, must-revalidate, stale-while-revalidate=60` | Arena state; changes per round. |
| `/api/arenas/:id/yield` | GET | public | `public, max-age=60, must-revalidate, stale-while-revalidate=300`; `public, max-age=3600, immutable` for SETTLED arenas | Finished arenas' series can never change. |
| `/api/oracle/yield` | GET | public | `public, max-age=15, must-revalidate, stale-while-revalidate=60` | Reports freshness/ageSeconds, so kept short. |
| `/api/maintenance/status` | GET | public | `public, max-age=10, must-revalidate, stale-while-revalidate=60` | Asked before any mutation; short max-age keeps transitions timely. |
| Everything else (incl. leaderboard, users, payouts, admin) | any | auth | `no-store` | Personalized/authenticated or mutation; never shared. |

Tunables (see `backend/.env.example`):

- `LANDING_STATS_CACHE_MAX_AGE_SECONDS` (default `30`)
- `LANDING_STATS_STALE_WHILE_REVALIDATE_SECONDS` (default `300`)

Both must stay **below** the frontend ISR window (60s) so the edge never serves
something older than the page that embeds it.

## Configuration revalidation flow

```
        on-chain config change
                 │
                 ▼
   POST /api/webhooks/config-changed   (HMAC via ORACLE_WEBHOOK_SECRET)
                 │
                 ▼
        RevalidationService.revalidateConfig(reason, contracts[])
                 │                         │
                 │                         └─▶ invalidateContractCapability(id)
                 │                              (drops negotiated-version + metadata caches)
                 ▼
   1. cache.invalidate("arenas:list")
   2. cache.invalidate("leaderboard")
                 │
                 ▼  signed POST (REVALIDATION_WEBHOOK_SECRET)
   frontend POST /api/revalidate
                 │
                 ├─▶ revalidateTag("landing-stats")
                 └─▶ revalidatePath("/")
```

- **Inbound** (`/api/webhooks/config-changed`): authenticated with the existing
  webhook keyring (`ORACLE_WEBHOOK_SECRET`, with rotation support). Reusing the
  oracle secret is deliberate — it is the same trusted on-chain watcher
  infrastructure, and a second secret would add rotation surface without moving
  the trust boundary.
- **Outbound** (`RevalidationService`): HMAC-SHA256 over
  `${timestamp}.${body}`, header `x-revalidate-signature: sha256=…` plus
  `x-revalidate-timestamp`. The frontend rejects anything outside a 5-minute
  replay window.
- **Failure is non-fatal.** If the frontend is unreachable, the backend logs and
  swallows the error: the ISR window is a bounded backstop, so a missed webhook
  degrades to "stale for at most 60s", never to an error surfaced to the
  on-chain watcher.
- **Config is optional.** With no `REVALIDATION_WEBHOOK_SECRET`, on-chain
  changes still purge backend caches; only the frontend notification is skipped.

## Frontend ISR

- `frontend/src/app/page.tsx` sets `export const revalidate = 60` (from
  `LANDING_REVALIDATE_SECONDS`, asserted `<= 60` by a unit test).
- `fetchLandingStats` attaches `next: { revalidate: 60, tags: ["landing-stats"] }`.
- A backend outage resolves to empty stats rather than breaking the marketing
  page; the next revalidation retries.

## Load-test evidence

`npm run bench:edge-cache` (in `backend/`) drives the real `publicCache`
middleware over loopback HTTP with a shared cache in front that honours the
emitted directives.

```
Scenario                          | Client RPS | Origin reqs | Origin RPS
----------------------------------|------------|-------------|-----------
No edge cache (baseline)          |       4963 |       14948 |       4983
Edge cache (publicCache + SWR)    |    3647176 |         100 |         33

Origin-request reduction: 99%
Backend RPS reduction: 4983 -> 33 (4950 fewer req/s)
```

The residual 100 origin requests are the coalesced cold-miss fan-out: 100
clients raced the first request before the cache was populated. Once warm, the
edge serves the full burst.

## Tests

- `backend/src/middleware/__tests__/cachePolicy.test.ts` — directive shape, the
  personalized-request guard, and the `no-store` default.
- `backend/src/routes/__tests__/stats.route.test.ts` — landing stats headers and
  payload.
- `backend/src/routes/__tests__/webhooks.route.test.ts` — inbound HMAC auth.
- `backend/src/services/__tests__/revalidationService.test.ts` — tag purge,
  contract invalidation, signing, and non-fatal failure.
- `frontend/src/app/api/revalidate/__tests__/route.test.ts` — outbound webhook
  verification and replay window.
- `frontend/src/shared/lib/__tests__/landingStats.test.ts` — ISR window and
  fallback behaviour.

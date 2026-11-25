# Signed Server-Time Synchronization (#1401)

## Ownership and state

`serverTimeService.issueSignedServerTime` owns issuing: it signs the
server's current time with the same JWT keyring every other token in this
codebase uses (`config/secretKeyring.ts`), so a client-reported time can
be traced back to this server rather than trusted on faith. Tokens expire
after 5 minutes — short enough that a stale token cannot be replayed hours
later, long enough that normal request latency and clock refresh cadence
never hit it.

`GET /api/arenas/time` (`routes/arenaTime.ts`, mounted from `routes/arenas.ts`)
owns the HTTP boundary and is intentionally its own module rather than
inline in `arenas.ts`; see that file's comment for why.

`useServerTimeSync` (frontend) owns keeping a client-side clock offset
fresh: it fetches on mount, every 60 seconds while the tab is visible, and
immediately on regaining visibility (covers both a background-tab
throttle and a device waking from sleep, which look identical to the page
visibility API). `useArenaTimer`'s existing `sync(serverSeconds)` method
is the consumer — the offset this hook produces feeds directly into that
call.

## Failure and compatibility

A failed sync (network error, non-OK response, malformed body) never
clears the previous offset — the hook keeps ticking on the last known-good
estimate rather than reverting to raw, unsynced `Date.now()`. This is a
deliberate degrade-gracefully choice: a slightly stale offset is closer to
correct than none at all.

`useArenaTimer.sync` was already a public method before this change
(previously described in its own comment as a "mock implementation for
now"); this feature is its first real caller. No existing behavior
changes for a caller that never calls `sync`.

`GET /api/arenas/time` is a new, unauthenticated endpoint with no prior
callers and no response-shape precedent to preserve; versioned the same
way `getTimeline`/`diagnose` are (`{ version: 1, ... }`).

## Observability

`inversearena_server_time_issued_total` counts every token issued.
`inversearena_server_time_verified_total{outcome}` counts verification
attempts by outcome, reusing the existing `secretKeyVerificationsTotal`
metric and `secret_key_verification`/`server_time_verification_failed`
log events already emitted by `config/secretKeyring.ts` for every other
JWT purpose, so server-time verification shows up in the same
rotation-health dashboards without a parallel metric family.

## Edge cases covered

- Clock skew: the client never trusts its own `Date.now()` for round
  countdowns once synced; it trusts `Date.now() + offset`.
- Device sleep: page-visibility regain forces an immediate resync rather
  than waiting up to 60s for the next interval tick.
- Reconnect: the same visibility-regain path also covers a tab that lost
  and regained network/focus.
- Failed sync: previous offset is retained, not discarded.
- Round-trip latency: the offset calculation splits the difference
  against the midpoint of the request/response, the same correction NTP
  uses for one-way network latency, rather than assuming zero latency.
- Key rotation mid-round: verification tries the current key, then the
  previous key while its overlap window is open (`verificationCandidates`,
  shared with every other JWT purpose) — a token issued just before a
  rotation does not become unverifiable mid-round.

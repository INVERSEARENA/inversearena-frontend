# Transaction Intents — Resumable Wallet-Signed Actions

This document describes the "transaction intent" mechanism added to track user-wallet-signed
actions (create pool, stake, unstake, join arena, commit/reveal a choice, claim winnings) from
the moment their unsigned XDR is built through wallet signing and on-chain submission, so a
wallet rejection or an expired signing window can be resumed against the same record instead of
silently discarded (#1381).

---

## 1. Ownership

An intent is owned by exactly the wallet public key that will sign it (`ownerWallet`). A request
for an intent id owned by a different wallet is indistinguishable from a request for an id that
does not exist (`404 INTENT_NOT_FOUND`), so ids cannot be probed to infer another user's activity
— the same fail-closed pattern `canAccessTransaction` uses for payout records.

**Ownership is self-reported, not JWT-verified — a deliberate, disclosed trade-off.** This
repository's frontend has no wallet-login flow wired up anywhere: every existing
frontend-to-backend call is unauthenticated `fetch()`, even against routes nominally gated by
`requireAuth` server-side (a pre-existing gap, not introduced here). Wiring a real
nonce-sign-verify login flow into every call site is a separate, materially larger feature outside
#1381's scope. `POST /api/transaction-intents` and its sub-resource routes therefore accept
`ownerWallet` as a plain, Zod-validated field in the request body/query rather than reading it
from `req.user.walletAddress`.

This does **not** create a fund-safety issue: an intent record holds no authority over any
account. It stores an unsigned (and later, wallet-signed) XDR envelope for bookkeeping only — the
backend never captures a private key and never submits on the user's behalf (§6). A caller who
mis-states another wallet's address can at most pollute that wallet's own intent *rows*
(observable noise, no funds movement, no ability to forge a signature), which is why this is an
acceptable interim boundary rather than blocking the feature on a full auth rollout. If/when a
real login flow lands, swapping `ownerWallet` for `req.user.walletAddress` is a small, localized
change (the ownership check itself, `requireOwnedIntent` in `transactionIntentService.ts`, does
not need to change).

## 2. State machine

```
        create/resume
             |
             v
         +--------+   markAwaitingSignature   +--------------------+
         | built  | -------------------------> | awaiting_signature |
         +--------+                            +--------------------+
             ^                                    |          |
             |         recordSignatureRejected     |          | attachSignedXdr
             +-------------- OrExpired ------------+          v
                                                          +-----------+
                                                          | submitted |
                                                          +-----------+
                                                             |      |
                                              recordSubmissionOutcome
                                                             |      |
                                                      confirmed  failed

  (built | awaiting_signature | submitted) --[TTL lapses]--> expired
```

- **built**: the unsigned XDR has been registered; no wallet interaction has happened yet.
- **awaiting_signature**: handed to the wallet for signing. `signAttempts` increments on every
  entry into this state, including retries.
- **submitted**: the wallet returned a signature; the client has called (or is about to call) the
  existing `submitSignedTransaction` against Soroban RPC directly. `attempts` increments here.
- **confirmed / failed**: terminal. Set once the client's own on-chain submission call resolves
  or throws — this service never submits on the user's behalf (see §6).
- **expired**: terminal. Set lazily, the first time any read or transition touches an intent
  whose `expiresAt` has lapsed, and proactively by a periodic sweep (`expireStaleIntents`) for
  intents nobody ever reads again (§5's "restart during work" case).

A wallet rejection or a signing-UI timeout does **not** move an intent to a terminal state — it
calls `recordSignatureRejectedOrExpired`, which returns the intent to `built`. A client "Try
Again" then calls `markAwaitingSignature` again against the **same** intent id and **same**
`unsignedXdr`, which is what makes rebuild-without-resubmit possible: there is nothing to
resubmit until a signature actually exists, so the "envelope" being protected against double
submission is the signed XDR, attached exactly once per successful `attachSignedXdr` call while
the intent is `awaiting_signature`.

`markAwaitingSignature` fails closed once `signAttempts` reaches `INTENT_MAX_SIGN_ATTEMPTS`
(default 5): the intent moves straight to `failed` rather than looping forever against a wallet
that keeps rejecting.

## 3. Idempotency and resumption

`idempotencyKey` is caller-supplied and stable across retries of the same logical action (the
frontend hook derives it from the action kind + its parameters + the signing wallet, persisted in
`sessionStorage` so a page refresh mid-flow can still resume it). `POST /transaction-intents`
looks up any existing record for that key first:

- If found and not expired: returns it (`mode: "resumed"`) instead of creating a second row.
- If found and expired: the caller must mint a **new** idempotency key. An idempotency key is
  never reused across two different unsigned envelopes, so an expired key never silently produces
  a duplicate active intent under the same key (which would also collide with the unique index on
  `idempotencyKey`).
- Otherwise: creates a fresh intent in `built`.

## 4. Compatibility constraints

- **No new REST/Soroban shape changes to existing endpoints.** This is entirely additive: a new
  `/api/transaction-intents` resource, with no changes to `submitSignedTransaction`'s Soroban RPC
  usage, the composer's XDR-assembly functions, or any existing endpoint's request/response shape.
- **The composer stays stateless.** `soroban-transaction-composer.ts` continues to be pure,
  synchronous XDR assembly with no I/O — intent tracking lives one layer up, in the orchestration
  hook, not in the composer itself.
- **Existing call sites keep working even if the intents API is unreachable.** `useTransactionIntent`
  treats a failure to reach `/api/transaction-intents` as non-fatal to the underlying wallet flow
  (it logs and proceeds without a tracked intent) rather than blocking the user from signing —
  resumability is a reliability improvement, not a new hard dependency for the golden path.

## 5. Failure behavior / edge cases

| Edge case | Handling |
|---|---|
| Duplicate delivery (client sends the create call twice) | Second call resolves to `mode: "resumed"` against the same row (§3). |
| Stale reads | Every read (`getIntent`) and every transition lazily checks `expiresAt` first and flips to `expired` before doing anything else, so a caller never acts on stale `awaiting_signature`/`submitted` state past its TTL. |
| Partial failure (signed but submission throws) | `attachSignedXdr` already moved the intent to `submitted` before the client's Soroban RPC call runs; `recordSubmissionOutcome({status:"failed"})` records the terminal state without needing to re-derive what happened. |
| Restart during work (tab closed mid-flow) | `expireStaleIntents()` sweeps `built`/`awaiting_signature`/`submitted` rows past `expiresAt` independent of any caller returning — safe to call repeatedly/concurrently, since expiring an already-terminal intent is a no-op. |
| Network mismatch | Not tracked by this service (the composer already binds `networkPassphrase` at XDR-build time; an intent's XDR is only ever valid for the network it was built against, same as any other Soroban transaction). |
| Maximum-size input | `unsignedXdr`/`signedXdr` are capped at 200,000 characters at the Zod boundary, matching the existing `SignPayoutBodySchema` convention. |
| Concurrent requests for the same key | The repository's unique index on `idempotencyKey` makes a true race resolve to one winner; the loser's insert fails and the caller should retry the create call, which then resolves to `mode: "resumed"`. |

## 6. Why this is not the payout system

`backend/src/services/paymentService.ts` already solves a state-machine-plus-idempotency problem
that looks superficially similar, and this design deliberately mirrors its shape (status enum,
idempotency key, attempts counter). The two are kept as separate services and separate storage
because they track fundamentally different actors:

| | Transaction intents (this doc) | Payments (`paymentService.ts`) |
|---|---|---|
| Who signs | The end user's own wallet | This backend's hot signer / KMS |
| Who submits to Soroban RPC | The client, directly | This backend |
| What it protects against | Losing track of a built-but-unsigned envelope across a rejected/expired signature | Double-spending a payout across an ambiguous retry |
| Backing store | New `TransactionIntent` Mongo collection | Existing `Transaction` Mongo collection |

Reusing the existing `Transaction` model/collection for both would have conflated two lifecycles
that only coincidentally share a similar shape.

## 7. Metrics and logging

- `inversearena_intent_created_total{kind}`, `inversearena_intent_resumed_total{kind}` — creation
  vs. resumption rate per action kind.
- `inversearena_intent_outcome_total{kind,status}` — terminal outcomes (confirmed/failed/expired).
- `inversearena_intent_sign_retry_total{kind,reason}` — how often signing is retried, broken down
  by `rejected` / `expired` / `retry`.
- `inversearena_intent_latency_seconds{kind,status}` — time from creation to a terminal status.
- Structured logs via `contextLogger()` on creation/resumption and on reaching a submission
  outcome, carrying the request id (per the existing `#661` convention).

See `backend/src/utils/metrics.ts` for the metric definitions and
`backend/src/services/transactionIntentService.ts` for where they're recorded.

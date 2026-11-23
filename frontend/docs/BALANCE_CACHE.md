# Wallet Balance Cache (#1625)

## Overview

The header, the join modal and the stake modal all need the connected wallet's
XLM and USDC balance. Before this cache each of them issued its own Horizon
request for the same account, and none of them refreshed after a confirmed
transaction — so the UI kept showing the pre-transaction amount until
something unrelated happened to re-render.

`frontend/src/shared/lib/stellar/balance-cache.ts` owns one app-wide cache
that all of them read through.

## Ownership

The cache owns three things and nothing else does:

| Concern | Owner |
| --- | --- |
| The cached amounts and their freshness | `BalanceCache` |
| De-duplicating concurrent Horizon reads | `BalanceCache.load` |
| Deciding *when* a cached amount is wrong | the transaction flow controller |

`fetchAssetBalance` / `fetchWalletBalance`
(`frontend/src/shared/lib/stellar/stellar-balance.ts`) stay pure: they always
hit the network. The cache is a layer *on top* of them, so a caller that
needs an authoritative number can always bypass it.

## Cache key

```
<network scope>|<wallet public key>|<asset code>
```

The network scope is part of the key because testnet and mainnet point at
different Horizon servers and can hold the same public key with different
balances. A cached testnet balance must never be served on mainnet.

## State transitions

```text
                read (no entry)
   (absent) ─────────────────────► (loading)
       ▲                              │
       │                              │ loader resolves
       │                              ▼
       │                         (fresh) ──► read → served from cache
       │                              │
       │        invalidate            │ age > stale window
       └──────────────────────────────┤
                                      ▼
                                  (stale) ──► read → served immediately,
                                      │            revalidation in background
                                      ▼
                                  (fresh)
```

- **fresh** — served without touching the network.
- **stale** — served immediately (the caller gets the last known amount
  without waiting), and revalidated in the background. When the refresh lands,
  the cache notifies its subscribers so the UI updates.
- **absent** — the caller waits for the shared in-flight read.

Failures never produce a cache entry. A rejected loader leaves the cache
untouched and the error propagates to the caller as `StellarBalanceError`
(#1295): "couldn't find out" must never be remembered as "zero".

## Invalidation

The transaction flow controller invalidates the cache the moment a transaction
confirms:

- `useTransactionIntent` (`frontend/src/shared/lib/hooks/useTransactionIntent.ts`)
  calls `invalidateWalletBalances(publicKey)` right after
  `submitSignedTransaction` resolves. This covers stake, join, leave, commit,
  reveal, claim and pool creation.
- `useTransactionFlow` (`frontend/src/shared-d/hooks/useTransactionFlow.ts`)
  does the same once the flow reaches the `confirmed` stage, when it is given
  a `publicKey`.

Invalidation is unconditional and cannot fail the confirmed transaction: the
balance did change on-chain, so the cached copy is simply wrong.

`WalletProvider` subscribes to the cache and re-reads on every write and every
invalidation for the connected wallet. That is why a confirmed transaction
updates the displayed balance without any component polling Horizon.

## Visibility-aware refresh

A wallet's balance can move while the tab is in the background — a payment
sent from another device, an auto-compounding yield vault. `WalletProvider`
re-reads the balance when the tab becomes visible again, using the
stale-while-revalidate path: the last known amount is shown immediately and
refreshed in the background.

An explicit user-triggered refresh (`refreshBalance()`) always bypasses the
freshness window and re-reads from Horizon.

## Edge cases covered

- **Wallet switch mid-request.** The cache is keyed by wallet, so a balance
  fetched for the previous wallet is never served for the new one.
- **Trustline removed.** The read fails or returns a genuine zero; both are
  handled the same way as before the cache existed, because the cache never
  invents a value.
- **Horizon outage.** The failure is not cached, and the last known amount
  stays on screen (`balanceError` is surfaced) instead of collapsing to zero.
- **Concurrent consumers.** N components asking for the same wallet+asset
  produce exactly one Horizon request.

## Related files

- `frontend/src/shared/lib/stellar/balance-cache.ts` — the cache
- `frontend/src/shared/lib/stellar/stellar-balance.ts` — the pure Horizon reads
- `frontend/src/shared/lib/hooks/useTransactionIntent.ts` — invalidation on confirmation
- `frontend/src/shared-d/hooks/useTransactionFlow.ts` — invalidation on confirmation
- `frontend/src/features/wallet/components/WalletProvider.tsx` — the consumer

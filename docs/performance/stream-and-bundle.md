# Arena stream, ledger reads, and the animation bundle

## SSE deltas and compression (#1767)

JSON responses are brotli- or gzip-compressed above 1024 bytes
(`backend/src/middleware/responseCompression.ts`). Requests that accept
`text/event-stream`, and any path containing `/stream`, are not compressed,
so a proxy cannot buffer the arena stream waiting for a compressor flush.

When a snapshot changes, the poller publishes a `delta` envelope whose
payload is the top-level fields that changed, with `version` and
`previousVersion`. A full `snapshot` is sent on the first publish, every
10th publish, and whenever the delta is not smaller than the snapshot.
`inversearena_arena_stream_update_bytes_total` counts the JSON bytes by
kind (`snapshot` or `delta`).

`useArenaStream` applies a delta only when `previousVersion` is the version
it last applied. A gap, a delta with no base snapshot, or a malformed patch
reconnects with `resync=1` and takes the next full snapshot.

## Ledger entry reads (#1768)

`contract/fixtures/storage-layout/arena-keys.json` names the hot persistent
keys (config, winner, player, settlement). `ledgerEntryReader` encodes them
and reads them with `getLedgerEntries` in batches of 200. A layout-version
mismatch, a value that does not decode, or an archived entry falls back to
the existing `simulateTransaction` path. `getOnChainWinner` tries the ledger
read first.

A batch of the hot keys is one RPC call. The same keys read by simulation
would be one host execution per key. The unit test pins that call count.

## Animation package (#1774)

Direct dependency `framer-motion` is removed. Components import `m` from
`motion/react`, and `ClientProviders` wraps the tree in `LazyMotion` with
`domAnimation`. ESLint rejects `framer-motion` and a `motion` named import
from `motion/react`.

`motion` still depends on `framer-motion` internally, so the lockfile keeps
one copy of that package as a transitive dependency. The client no longer
imports it from two paths. Bundle-analyzer output was not regenerated in
this change; the import graph above is the diff. `scripts/check-perf-budgets.ts`
still gates the committed bundle budgets.

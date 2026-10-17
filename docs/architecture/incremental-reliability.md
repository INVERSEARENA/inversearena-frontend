# Incremental reliability slice

The API owns materialized leaderboard state and treats Redis as a rebuildable cache;
Postgres remains authoritative. A refresh is monotonic: a successful page is written
with its generation and incomplete/failed refreshes never replace the last complete
generation. Duplicate refreshes are safe because writes use the same generation key.

Application wiring owns construction and bootstrap owns listening. Shutdown is owned by
`shutdownApplication`, which stops accepting HTTP work, then workers/queues, then
database and Redis connections. Repeated shutdown signals are ignored by the entrypoint.

The arena feed keeps the existing event shape and cursor semantics. The browser owns
the visible window and only renders a bounded slice; older/newer events are retained
in a deduplicated client buffer. Soroban hydration uses one snapshot ledger for every
arena in a batch; a partial RPC failure fails the batch rather than mixing ledgers.

No REST, Soroban, event, or storage contract is changed by this slice.

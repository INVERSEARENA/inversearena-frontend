# Transactional outbox

`outbox_events` is the durable boundary for side effects caused by Postgres
writes. A workflow inserts its event in the same Prisma transaction as its
domain state. `OutboxDispatcher` claims rows with `FOR UPDATE SKIP LOCKED`,
sets a time-limited lease, and publishes them outside the database
transaction. Failed deliveries are released with bounded exponential backoff.

Delivery is at least once: a worker can publish successfully and crash before
acknowledging the row. Publishers must therefore be idempotent by event `id`
or `dedupeKey`. The unique dedupe key prevents a replayed database transaction
from creating a second logical event.

Current migrations:

* `arena.created` is committed with the arena row. Dispatch invalidates the
  arena and arena-list cache tags.
* `arena.projection.updated` is committed with each checkpoint update. Dispatch
  publishes a JSON event to the Redis channel `arena:projection:<arenaId>`.

Apply the Prisma migration before deploying the application. The dispatcher
starts with the backend process and drains on graceful shutdown. Redis
publication is a fan-out notification, not the durable record; the outbox row
remains the source of delivery state.

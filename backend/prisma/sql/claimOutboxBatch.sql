WITH candidates AS (
  SELECT id
  FROM outbox_events
  WHERE published_at IS NULL
    AND available_at <= NOW()
    AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
  ORDER BY created_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT $1
)
UPDATE outbox_events AS event
SET lease_owner = $2,
    lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'),
    attempts = event.attempts + 1
FROM candidates
WHERE event.id = candidates.id
RETURNING event.id,
          event.event_type AS "eventType",
          event.aggregate_id AS "aggregateId",
          event.dedupe_key AS "dedupeKey",
          event.payload,
          event.attempts,
          event.created_at AS "createdAt",
          event.lease_owner AS "leaseOwner";

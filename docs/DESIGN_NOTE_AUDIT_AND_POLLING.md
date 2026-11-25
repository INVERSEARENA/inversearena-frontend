# Audit and Polling Boundary Design

## Ownership and state

The audit middleware owns request outcome capture. A typed actor and resource are written alongside the legacy `adminId`, `resourceType`, and `resourceId` fields so existing readers remain compatible. Audit records are immutable after creation; `correlationId` links retries and cross-module work.

Arena polling owns the state machine. A poll moves through `fetch -> verify -> persist -> publish`. Each stage is independently retryable; a failed stage leaves the previous verified snapshot visible. Publication is keyed by the existing event sequence and is therefore duplicate-safe for reconnects.

The frontend polling hook owns one scheduler. Visibility pauses the scheduler and aborts in-flight work. Failures use capped exponential backoff with jitter; successful reads reset the backoff. Request generations suppress late responses after abort, refresh, or unmount.

## Failure and compatibility

Audit-write failures are logged and never change the HTTP response. Missing correlation IDs and legacy audit rows remain valid. Audit queries add actor, resource, result, and correlation filters without changing the response shape.

Deployment manifests are injected into contract factories. The legacy URL constructor remains supported during migration; named contract lookup fails closed when a manifest entry is absent. Network and contract version changes are represented by a new manifest rather than module-global mutation.
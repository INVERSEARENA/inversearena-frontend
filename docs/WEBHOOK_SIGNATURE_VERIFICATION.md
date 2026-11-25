# Webhook Signature Verification

## Overview

All webhook deliveries from InverseArena are HMAC-SHA256 signed with a timestamp, enabling integrators to verify authenticity and detect replay attacks.

## Signature Format

The signature is delivered in the `X-Webhook-Signature` HTTP header as a comma-separated list of parameters:

```
X-Webhook-Signature: ts=<timestamp>,sig=<hmac_hex>
```

- `ts`: Unix timestamp (seconds) when the signature was created.
- `sig`: Hex-encoded HMAC-SHA256 digest.

## Verification Algorithm

1. Extract `ts` and `sig` from the `X-Webhook-Signature` header.
2. Verify the timestamp is recent (within 5 minutes by default) to reject replays:
   ```
   abs(current_timestamp - ts) <= 300 seconds
   ```
3. Reconstruct the signed message as: `"{ts}.{json_payload}"`
   - `ts` is the timestamp from the header.
   - `json_payload` is the exact JSON string of the webhook payload body (deterministic serialization).
4. Compute HMAC-SHA256 using your webhook secret and the reconstructed message.
5. Compare the computed digest (hex) with the `sig` from the header using constant-time comparison.

## TypeScript Example

```typescript
import { createHmac, timingSafeEqual } from "crypto";

interface WebhookPayload {
  id: string;
  timestamp: string;
  eventType: string;
  aggregateId: string;
  data: unknown;
}

interface SignedEnvelope {
  payload: WebhookPayload;
  signature: string;
}

function verifyWebhookSignature(
  envelope: SignedEnvelope,
  secret: string,
  toleranceSec = 300
): boolean {
  const { payload, signature } = envelope;

  // Parse signature header
  const parts = signature.split(",");
  const tsPart = parts.find((p) => p.startsWith("ts="));
  const sigPart = parts.find((p) => p.startsWith("sig="));

  if (!tsPart || !sigPart) {
    console.error("Invalid signature format");
    return false;
  }

  const timestamp = parseInt(tsPart.slice(3), 10);
  const providedSig = sigPart.slice(4);

  // Check timestamp freshness
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSec) {
    console.error("Signature timestamp is stale or in future");
    return false;
  }

  // Reconstruct signed message: "ts.payload_json"
  const payloadJson = JSON.stringify(payload);
  const message = `${timestamp}.${payloadJson}`;

  // Compute HMAC-SHA256
  const hmac = createHmac("sha256", secret);
  hmac.update(message);
  const expectedSig = hmac.digest("hex");

  // Constant-time comparison to prevent timing attacks
  try {
    return timingSafeEqual(
      Buffer.from(providedSig, "hex"),
      Buffer.from(expectedSig, "hex")
    );
  } catch {
    console.error("Signature hex decoding failed");
    return false;
  }
}

// Usage
const envelope: SignedEnvelope = {
  payload: {
    id: "evt-123",
    timestamp: "2026-11-21T13:11:37.000Z",
    eventType: "arena.created",
    aggregateId: "arena-456",
    data: { entryFee: 100 },
  },
  signature: "ts=1700584297,sig=abcdef1234567890...",
};

const secret = process.env.WEBHOOK_SECRET!;
if (verifyWebhookSignature(envelope, secret)) {
  console.log("Signature verified ✓");
} else {
  console.log("Signature verification failed ✗");
  process.exit(1);
}
```

## Python Example

```python
import hmac
import hashlib
import json
import time
from typing import Any, Dict

def verify_webhook_signature(
    envelope: Dict[str, Any],
    secret: str,
    tolerance_sec: int = 300
) -> bool:
    payload = envelope["payload"]
    signature = envelope["signature"]

    # Parse signature header
    parts = signature.split(",")
    ts_part = next((p for p in parts if p.startswith("ts=")), None)
    sig_part = next((p for p in parts if p.startswith("sig=")), None)

    if not ts_part or not sig_part:
        print("Invalid signature format")
        return False

    timestamp = int(ts_part[3:])
    provided_sig = sig_part[4:]

    # Check timestamp freshness
    now = int(time.time())
    if abs(now - timestamp) > tolerance_sec:
        print("Signature timestamp is stale or in future")
        return False

    # Reconstruct signed message: "ts.payload_json"
    payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    message = f"{timestamp}.{payload_json}"

    # Compute HMAC-SHA256
    expected_sig = hmac.new(
        secret.encode(),
        message.encode(),
        hashlib.sha256
    ).hexdigest()

    # Constant-time comparison
    return hmac.compare_digest(provided_sig, expected_sig)


# Usage
envelope = {
    "payload": {
        "id": "evt-123",
        "timestamp": "2026-11-21T13:11:37.000Z",
        "eventType": "arena.created",
        "aggregateId": "arena-456",
        "data": {"entryFee": 100},
    },
    "signature": "ts=1700584297,sig=abcdef1234567890...",
}

secret = os.environ["WEBHOOK_SECRET"]
if verify_webhook_signature(envelope, secret):
    print("Signature verified ✓")
else:
    print("Signature verification failed ✗")
    exit(1)
```

## Webhook Payload Structure

```json
{
  "payload": {
    "id": "evt-abc123",
    "timestamp": "2026-11-21T13:11:37.000Z",
    "eventType": "arena.created",
    "aggregateId": "arena-456",
    "data": {
      "arenaId": "arena-456",
      "entryFee": 100,
      "maxPlayers": 32
    }
  },
  "signature": "ts=1700584297,sig=..."
}
```

## Request Headers

Every webhook delivery includes:

- `X-Webhook-Signature`: Signature (see above)
- `X-Webhook-Id`: Event ID (same as `payload.id`)
- `X-Webhook-Timestamp`: ISO-8601 timestamp
- `X-Webhook-Replay`: `"true"` if this is a manual replay; omitted otherwise
- `Content-Type`: `application/json`

## Event Types

Current event types include:

- `arena.created` — Arena initialized
- `arena.resolved` — Round resolved / arena settled
- Other event types may be added; integrators should handle unknown types gracefully

## Best Practices

1. **Always verify signatures** before processing webhook data.
2. **Use idempotency keys** to deduplicate: derive from `payload.id` + your subscription ID.
3. **Check the timestamp** to reject old replays (5-minute default tolerance).
4. **Return HTTP 2xx quickly** (< 5 seconds) to avoid retries; use async processing if needed.
5. **Implement exponential backoff** retries on your side if outbound webhooks fail.
6. **Log delivery attempts** for debugging and audit trails.

## Retry Policy

Webhooks are delivered with **at-least-once semantics**:

- Initial delivery attempts immediately.
- Failed deliveries retry with exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, 60s.
- Webhooks are **auto-disabled** after 10 consecutive delivery failures.
- Operators can **manually replay** specific events via the admin API.

## FAQ

**Q: How do I rotate my webhook secret?**
A: Create a new subscription with the new secret, then delete the old one. During transition, verify against both secrets if needed.

**Q: What if my webhook endpoint is slow?**
A: InverseArena enforces a 5-second timeout per delivery and does not block other subscribers. Return quickly and process async.

**Q: Can I filter which events I receive?**
A: Yes. When creating a subscription, specify `eventFilters` (array of event types). Empty array or `["*"]` means all events.

**Q: How do I replay a specific webhook?**
A: Use the admin API: `POST /api/admin/webhooks/replay` with `subscriptionId` and `outboxEventId`.

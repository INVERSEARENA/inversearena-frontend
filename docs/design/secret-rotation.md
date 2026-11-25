# Design note: secret rotation readiness for JWT and webhook keys (#1456)

## Problem

`JWT_SECRET` and `ORACLE_WEBHOOK_SECRET` were each a single static value.
Rotating either one invalidated every live session, or every in-flight oracle
webhook, at the moment of deploy. Nothing checked the configuration at boot:
the JWT secret length was only checked lazily on the first login.

## Ownership

- `backend/src/config/secretKeyring.ts` owns key material. It builds a
  keyring for each purpose and runs the readiness check.
- `backend/src/config/validate.ts` → `assertSecretRotationReadiness()` runs at
  boot through `validateConfig()`.
- `backend/src/services/authService.ts` signs and verifies JWTs with the
  keyring.
- `backend/src/middleware/verifyWebhook.ts` verifies oracle HMACs with the
  keyring.

## Key model and states

A keyring has one **current** key, used to sign and verify, and at most one
**previous** key, used to verify only, with an `expiresAt`. Each key has a
`kid`. The `kid` is either set explicitly (`*_KID`) or taken as a SHA-256
fingerprint (`fp-<12 hex>`). The fingerprint is stable across replicas
without any coordination.

```
stable ──(set *_PREVIOUS + *_PREVIOUS_EXPIRES_AT, new current)──▶ rotating
rotating ──(clock passes EXPIRES_AT)──▶ previous_expired (previous rejected; warn to remove)
previous_expired ──(unset *_PREVIOUS*)──▶ stable
```

## Verification rules

The rule behind this issue's acceptance criterion: overlap windows accept the
current and previous keys, and never accept an unknown key id.

- **The kid is present** in the JWT header or the `x-oracle-key-id` header:
  only the live key with that kid is tried. An unknown or expired kid gives
  no candidates and is rejected, **even if the signature would match another
  key**.
- **No kid is present.** This covers tokens issued before this change and
  oracle senders that don't send a kid yet. The current key is tried, then
  the previous key while its window is still open.
- JWT verification is pinned to `HS256`, so `alg: none` and algorithm
  confusion are rejected.
- A new JWT is always signed with the current key and carries its `kid`.
- An unknown webhook kid returns the same `401 WEBHOOK_SIGNATURE_INVALID` as a
  bad signature. The response does not reveal which kids exist.

## Boot checks (fail fast)

Errors (the process won't start):

- `JWT_SECRET` is missing or shorter than 32 characters.
- `*_PREVIOUS` is set without `*_PREVIOUS_EXPIRES_AT`, or the reverse.
- `*_PREVIOUS_EXPIRES_AT` can't be parsed, or is more than 30 days away.
- The previous secret or kid equals the current one.
- A kid contains characters outside `[A-Za-z0-9._-]`, or is longer than 64
  characters.

Warnings (logged): the previous key has expired and should be removed, or the
webhook secret is shorter than 16 characters. The webhook warning is not an
error so that older deployments keep booting.

## Failure behaviour

- The keyring is cached per process and rebuilt when the relevant env vars
  change, so a config reload needs no restart. On a restart during an overlap
  window, the process rebuilds the same keyring from env, because the
  fingerprints are deterministic.
- A duplicate webhook delivery verifies the same way each time. Replay
  protection is out of scope here.
- If the keyring is misconfigured at runtime, the request fails with a 5xx.
  It never falls back to accepting the request.

## Observability

- Metric `inversearena_secret_key_verifications_total{purpose,slot,outcome}`
  counts outcomes `accepted`, `unknown_kid` and `bad_signature` in the slots
  `current`, `previous` and `none`. If `slot="previous"` has been at zero
  for a full token TTL, it is safe to close the window early.
- The log `event=secret_rotation_readiness` is written at boot. The log
  `event=secret_key_verification` is written for previous-key accepts and for
  every rejection.

## Operator runbook

1. Generate a new secret.
2. Deploy with `JWT_SECRET=<new>`, `JWT_SECRET_PREVIOUS=<old>` and
   `JWT_SECRET_PREVIOUS_EXPIRES_AT=<now + refresh-token TTL>`. The TTL defaults
   to 7 days.
3. Watch `slot="previous"` fall to zero.
4. After the expiry, remove the `JWT_SECRET_PREVIOUS*` variables and deploy.
5. For the oracle webhook, do the same with the `ORACLE_WEBHOOK_SECRET*`
   variables. Switch the sender to the new secret, and optionally have it
   send `x-oracle-key-id`, while the window is open.

## Compatibility

- Tokens without a kid and senders that pass a single webhook secret keep
  working. `verifyWebhookSignature(secret: string)` is still supported.
- There are no REST changes. New tokens carry an extra `kid` header, which
  clients ignore.

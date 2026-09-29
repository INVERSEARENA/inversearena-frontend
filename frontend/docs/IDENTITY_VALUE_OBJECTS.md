# Identity Value Objects (#1522)

## Problem

Contract IDs, account IDs, network names, passphrases, and deployment aliases
were passed as plain `string` across configuration, caches, API DTOs, and
transaction builders. A syntactically valid identifier could be used in the
wrong namespace or on the wrong network with no compile-time or runtime guard.
Cache and idempotency keys did not consistently encode deployment identity, so a
testnet arena ID could collide with a mainnet one in a shared Redis instance.

## Solution

`frontend/src/shared-d/utils/identity-value-objects.ts` exports **branded
value types** and their constructors. A branded type is a plain `string` (or
`number`) at runtime, but its TypeScript type carries a phantom brand so it is
not assignable to a different branded type without an explicit parse call.

---

## Value-object catalogue

| Type | StrKey type | First char | Validation |
|---|---|---|---|
| `StellarAccountId` | `ed25519PublicKey` | `G` | `StrKey.isValidEd25519PublicKey` |
| `SorobanContractId` | `contract` | `C` | `StrKey.isValidContract` |
| `StellarTransactionHash` | — | `[0-9a-f]` | 64-char lowercase hex |
| `NetworkPassphrase` | — | — | 3–100 printable ASCII |
| `NetworkIdentity` | — | — | Derived from passphrase |
| `DeploymentRevision` | — | — | Positive integer |

### `NetworkBoundContractId`

```ts
interface NetworkBoundContractId {
  readonly contractId: SorobanContractId;
  readonly network:    NetworkIdentity;
}
```

Ties a contract to the network it was deployed on. Passing one across networks
is detectable at the type level. Construct with `bindContractToNetwork`.

---

## Design rules

1. **Never cast.** Do not write `"GABC…" as StellarAccountId`.  
   Always use the named constructor: `parseStellarAccountId("GABC…")`.

2. **Wire format is plain string.** API responses and Zod schemas use `string`.
   Convert at the ingress boundary with the parser; the brand disappears on
   serialisation (JSON.stringify).

3. **Add new types here.** Do not create ad-hoc branded types in other modules.

4. **`tryParse*` variants** return `null` instead of throwing and are safe for
   optional config (e.g. `NEXT_PUBLIC_RWA_VAULT_CONTRACT_ID`).

---

## Constructors and their behaviour

```ts
// Throws IdentityValidationError on failure:
parseStellarAccountId(raw)
parseSorobanContractId(raw, { allowPlaceholder?: boolean })
parseStellarTransactionHash(raw)
parseNetworkPassphrase(raw)
parseDeploymentRevision(raw)
bindContractToNetwork(rawContractId, passphrase, { allowPlaceholder? })

// Returns null on failure:
tryParseStellarAccountId(raw)
tryParseSorobanContractId(raw, opts)
tryParseStellarTransactionHash(raw)
tryParseNetworkPassphrase(raw)
```

`IdentityValidationError` carries `.kind`, `.input`, and `.reason` fields for
structured logging.

---

## NetworkIdentity

`NetworkIdentity` is a short, canonical string derived deterministically from
the network passphrase. It is used as the `{network}` segment in cache,
idempotency, and capability-scope keys.

| Passphrase | NetworkIdentity |
|---|---|
| `Test SDF Network ; September 2015` | `testnet` |
| `Public Global Stellar Network ; September 2015` | `mainnet` |
| Any other passphrase | `net-{fnv1a32(passphrase)}` |

Derivation: well-known passphrases map to human-readable aliases (see
`NETWORK_ALIASES`); all others use an 8-character FNV-1a 32-bit hex digest,
prefixed with `net-`. This keeps keys short while being collision-resistant for
any realistic set of Stellar networks.

---

## Canonical key builders

```ts
// Backend cache key — includes network identity (#1522)
arenaNetworkCacheKey(network, arenaId, "stats")
// → "arena:testnet:CDLZFC…:stats"

// Idempotency key for a wallet mutation
mutationIdempotencyKey(network, wallet, arena, round, "commit")
// → "idempotency:testnet:GBRP…:CDLZ…:3:commit"

// Capability-scope key
capabilityScopeKey(network, arena)
// → "capability:testnet:CDLZ…"
```

---

## Migrated boundaries

### Backend — `backend/src/cache/cacheService.ts`

`cacheKeys.arenaStats`, `arenaOnChainSnapshot`, `arenaSnapshotMeta`, and
`arenaVerifiedSnapshot` now include the network identity segment derived from
`STELLAR_NETWORK_PASSPHRASE`. `arenaDerivedCachePatterns` uses `arena:*:…` to
match across network segments during rollback invalidation.

`getNetworkIdentity()` is exported for tests; `_resetNetworkIdentityForTest()`
resets the lazily-cached identity between test cases.

### Frontend — `frontend/src/shared-d/utils/contract-client-factory.ts`

`createContract(id, opts)` now calls `parseSorobanContractId` before
constructing a `Contract` instance, rejecting malformed IDs at the factory
boundary. `createNetworkBoundContract(bound)` additionally checks that the
contract's `NetworkIdentity` matches the factory's configured passphrase.

### Frontend — `frontend/src/shared-d/utils/security-validation.ts`

`StellarPublicKeySchema`, `StellarContractIdSchema`, and
`NetworkPassphraseSchema` now delegate to the value-object parsers, so Zod
schemas and value objects share the same validation logic.

---

## Lint / codemod guidance

To prevent new unchecked casts at high-risk boundaries, add the following rule
to your ESLint configuration (e.g. via `@typescript-eslint/no-unsafe-type-assertion`
or a custom local rule):

```jsonc
// .eslintrc or eslint.config.mjs
{
  "rules": {
    // Flag `as StellarAccountId`, `as SorobanContractId`, etc. at boundaries:
    "@typescript-eslint/no-restricted-syntax": [
      "warn",
      {
        "selector": "TSAsExpression[typeAnnotation.typeName.name=/^(StellarAccountId|SorobanContractId|StellarTransactionHash|NetworkPassphrase|NetworkIdentity|DeploymentRevision)$/]",
        "message": "Use the parse* constructor from identity-value-objects.ts instead of casting."
      }
    ]
  }
}
```

For large-scale migration, a codemod can grep for regex patterns like
`/^G[A-Z2-7]{55}$/` or `CONTRACT_ID_REGEX` and replace them with calls to
`StrKey.isValidEd25519PublicKey` / `StrKey.isValidContract` via the parsers.

---

## Out of scope

- Monorepo-wide rewrite in one change (incremental migration is preferred).
- Device-to-device identity coordination.
- Cryptographic proof of contract deployment identity.

---

## Testing

```bash
pnpm exec jest identity-value-objects   # value object unit tests
pnpm exec jest contract-client-factory  # updated factory tests
pnpm exec jest                           # full frontend suite
pnpm exec tsc --noEmit                   # type-check
```

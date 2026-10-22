# Creator configuration templates (#1689)

## What this is

A **template** is a named, wallet-owned bundle of arena settings — stake
amount, asset, capacity, round schedule, deadlines and yield integrations —
that a creator can apply to the arena creation form instead of re-entering
the same values.

Templates are additive: the factory's `create_pool` is unchanged, and
applying a template never signs anything. It only prefills the form; the
form's own validation, the transaction preview and the balance/trustline
checks all still run afterwards.

## The two rules

**1. Templates store canonical values, never display strings.**

The stake amount is stored as a minor-unit integer (`stakeAmountMinor`) plus
the asset's `assetDecimals`; the asset and the integrations are contract
ids. "100 USDC" in a template would be ambiguous the moment the display
precision or the asset changes.

**2. A template is never trusted.**

Every save and every use revalidates the payload against:

- the current protocol bounds (capacity range, minimum stake, round speeds);
- the current registry lifecycle (#1688) — a deprecated or withdrawn asset,
  vault or oracle is reported, not silently accepted;
- the current deployment capabilities — the asset, vault and oracle a template
  names must be the ones the deployment is configured with.

The result is **field-level remediation**: a list of `{ field, code, message }`
that says exactly what is stale and what to do about it.

## Schema versions

`TEMPLATE_SCHEMA_VERSION` is the current payload version.

- An older payload is migrated deterministically (`migrateTemplatePayload`).
  The v0 → v1 migration cannot guess the minor amount from a display string,
  so it clears that field and the creator confirms it — intent is never
  rewritten by guesswork.
- A newer payload is **refused** with `TEMPLATE_SCHEMA_UNSUPPORTED`, both on
  save and on use. A template written by a newer deployment is reported as
  incompatible instead of being partially applied.

## API

All routes are wallet-authenticated (`Authorization: Bearer <access token>`)
and scoped to the owning wallet. A template that belongs to another wallet
is reported as `404 TEMPLATE_NOT_FOUND` — ownership cannot be probed by id.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/creator/templates?includeArchived=true` | list the creator's templates with their remediation |
| `POST` | `/api/creator/templates` | save a template |
| `GET` | `/api/creator/templates/:id` | read one template |
| `PATCH` | `/api/creator/templates/:id` | update a template (needs `expectedRevision`) |
| `POST` | `/api/creator/templates/:id/clone` | clone a template under a new name |
| `POST` | `/api/creator/templates/:id/archive` | archive or restore a template |
| `DELETE` | `/api/creator/templates/:id` | delete a template |
| `POST` | `/api/creator/templates/:id/use` | get the payload to prefill the form, revalidated |

### Concurrency

Every template carries a `revision`. An update must present the revision it
read in `expectedRevision`. A stale revision is refused with
`409 TEMPLATE_REVISION_CONFLICT` and the current revision, so a concurrent
edit is never silently overwritten.

### Duplicate names

Names are unique per wallet (including archived templates). A second
template with the same name is refused with `409 TEMPLATE_NAME_TAKEN`.

## Persistence

`creator_templates` (see `backend/prisma/schema.prisma` and the migration in
`backend/prisma/migrations/20261022000000_add_creator_templates`):

| Column | Meaning |
| --- | --- |
| `owner_address` | the wallet that owns the template |
| `name` | unique per owner |
| `schema_version` | the payload schema version it was written with |
| `status` | `active` or `archived` |
| `payload` | the canonical payload (JSON) |
| `revision` | the optimistic-concurrency counter |

## Client

`frontend/src/features/pools/model/arena-templates.ts` — the API client and
the conversions between the form values and the canonical payload
(`toTemplatePayload`, `applyTemplateToForm`).

`frontend/src/features/pools/components/TemplatePanel.tsx` — the panel in
the arena creation modal: save the current configuration, list the
templates, apply, clone, archive and delete, with empty and error states.
A template with remediation is shown with its field-level messages and
cannot be applied until it is fixed.

## Edge cases

| Case | Behaviour |
| --- | --- |
| Wallet switch | The list is refetched for the signed-in wallet; another wallet's templates are never visible (the API refuses them as not found). |
| Offline draft | The local draft (#1405) is untouched; templates are an additional, server-side source of prefill. |
| Deleted integration | The registry lifecycle read reports the integration as withdrawn; the template is reported with `*_DISABLED` remediation. |
| Network mismatch | The deployment capability check rejects an asset, vault or oracle that is not the one the deployment is configured with. |
| Partial migration | Only the fields that can be migrated deterministically are carried over; the rest is reported, never invented. |
| Template used during a config rollout | The use endpoint revalidates against the rules in force at that moment, so a rollout between the save and the use is reported as remediation rather than slipping through. |

## Tests

`backend/src/services/__tests__/creatorTemplateService.test.ts` covers
cross-wallet access, duplicate names, concurrent edits, deprecated assets,
changed bounds, a stake below the minimum, legacy and future schema
versions, clone/archive/delete, and a malformed payload.

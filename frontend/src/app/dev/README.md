# Dev component gallery

Local/staging gallery for component states (#1645). **Never part of the
production route surface** — `src/proxy.ts` 404s every `/dev/*` path in a
production build before it reaches the app router, and
`app/dev/layout.tsx` double-gates the same check.

## Reaching the gallery

| Environment | URL | Enabled? |
| --- | --- | --- |
| `next dev` | `http://localhost:3000/dev` | yes |
| production build | — | **no** (404) |
| production + `NEXT_PUBLIC_ENABLE_DEV_GALLERY=1` | `/dev` | yes (staging review only) |

## Pages

| Path | Covers |
| --- | --- |
| `/dev` | Index of gallery sections |
| `/dev/choice-cards` | `ChoiceCard`, `SelectionCard` — default / selected / disabled |
| `/dev/modals` | Shared `Modal` chrome + copy states for join / stake / pool-success / share |
| `/dev/arena-overlays` | `QuorumProgress`, `EntryStatsCards` waiting overlays |
| `/dev/lobby` | Lobby empty state and READY / ACTIVE / ELIMINATED participant rows |
| `/dev/pool-success-demo` | Migrated from `/pool-success-demo` |
| `/dev/share-test` | Migrated from `/arena-v2/share-test` |

## Adding a story

1. Create `frontend/src/app/dev/<story-name>/page.tsx` as a `"use client"` page.
2. Import the component under test. If it depends on wallet/contract hooks,
   either pass mock props or render only its presentational chrome — the
   gallery must not open a wallet connection.
3. Link it from the `SECTIONS` array in `frontend/src/app/dev/page.tsx`.
4. Cover the states the component actually has (default / selected / disabled /
   empty / error) rather than a single happy path.

### Mocking wallet-dependent components

Components under `components/modals/` and `features/arena-lobby/` pull
`useWallet` and the Stellar transaction builders. Prefer storying a
presentational sibling (or the shared `Modal` chrome) over wiring the real
hooks. If a component cannot render without a wallet, mock the module in the
story's colocated test and keep the story on the visual shell only.

## Verifying exclusion from production

```bash
cd frontend
NEXT_PUBLIC_ENABLE_DEV_GALLERY= npm run build
# route list must not serve /dev — every request 404s via proxy.ts
```

`frontend/src/shared/lib/dev-gallery.ts` owns the gate; unit tests live next to
the shared tests.

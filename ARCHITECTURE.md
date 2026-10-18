# Architecture

This document summarizes the live architecture of the repository as implemented in the current codebase.

## 1. System Overview

```mermaid
flowchart TD
  U[Player / Admin Browser] --> F[Frontend: Next.js App]
  F -->|REST + SSE| B[Backend: Express API]
  B -->|Prisma| DB[(PostgreSQL)]
  B -->|Jobs| Q[BullMQ / Worker Loop]
  B -->|RPC + XDR| S[Soroban / Stellar Network]
  Q --> S
  F -->|Wallet signing| W[Freighter / Stellar Wallet]
```

The frontend owns presentation, wallet connection, and client-side state. The backend owns persistence, authorization, round resolution, payout execution, and the arena stream endpoints. Prisma maps the domain objects into PostgreSQL tables.

## 2. Contract State Machine

The current backend round lifecycle is implemented in `backend/src/services/roundService.ts`.

```mermaid
stateDiagram-v2
  [*] --> OPEN
  OPEN --> CLOSED: closeRound
  CLOSED --> RESOLVED: resolveRound
  RESOLVED --> SETTLED: payout worker / settlement step
  SETTLED --> [*]
```

Guards in the service prevent illegal transitions:

- `closeRound` only accepts `OPEN`
- `resolveRound` accepts `OPEN` or `CLOSED`
- settlement is modeled in the schema and docs, and downstream payout processing consumes the resolved result

## 3. Round Resolution Flow

```mermaid
sequenceDiagram
  participant UI as Frontend
  participant API as Backend API
  participant DB as PostgreSQL
  participant CH as Soroban / Stellar

  UI->>API: submit choice / trigger round resolve
  API->>DB: load round + arena data
  API->>CH: compute or submit contract action
  CH-->>API: resolution result
  API->>DB: persist round metadata + elimination logs
  API-->>UI: updated state
  UI->>UI: refresh arena view / overlays
```

The arena page currently consumes live updates through an SSE stream at `GET /api/arenas/:id/stream` and falls back to local demo data when no demo arena ID is configured.

## 4. Payment Worker Pipeline

The payout flow is implemented around `backend/src/services/paymentService.ts`, the transaction repository, and the worker loop.

```mermaid
stateDiagram-v2
  [*] --> built
  built --> awaiting_signature: external signing required
  built --> queued: hot signer enabled
  awaiting_signature --> queued: signed XDR received
  queued --> submitted: worker submits to Soroban
  submitted --> confirmed: ledger confirmation
  submitted --> failed: max retries or terminal error
  confirmed --> [*]
  failed --> [*]
```

The worker uses the configured Soroban RPC client and a circuit breaker so submission failures do not cascade into the rest of the system.

## 5. Auth Flow

The wallet auth path is handled by `backend/src/middleware/auth.ts` and the frontend wallet hook.

```mermaid
sequenceDiagram
  participant UI as Frontend
  participant AUTH as Backend Auth Router
  participant JWT as JWT / Access Token

  UI->>AUTH: request nonce / sign challenge
  AUTH-->>UI: nonce or challenge payload
  UI->>UI: wallet signs challenge
  UI->>AUTH: signed payload
  AUTH-->>UI: access token
  UI->>UI: store auth state and use Bearer token
```

`requireAuth` decodes the access token and attaches `req.user.walletAddress`, which is then used by arena and pool creation endpoints.

## 6. RWA Yield Flow

The yield path is described in `docs/RWA_YIELD_FLOW.md` and is reflected in the frontend game copy and backend round statistics.

```mermaid
flowchart LR
  A[Player stake] --> B[Pool / Arena contract]
  B --> C[RWA vault / yield instrument]
  C --> D[Yield accrues over time]
  D --> E[Round resolution]
  E --> F[Winner payout = principal + yield]
```

The backend stores the round and elimination metadata required to reconstruct the yield flow and leaderboard outcomes.

## 7. Data Model

The Prisma schema is defined in `backend/prisma/schema.prisma`.

```mermaid
erDiagram
  USER ||--o{ TRANSACTION : has
  USER ||--o{ ELIMINATION_LOG : triggers
  ARENA ||--o{ POOL : contains
  ARENA ||--o{ ROUND : contains
  ROUND ||--o{ ELIMINATION_LOG : records

  USER {
    string id
    string walletAddress
  }

  ARENA {
    string id
    json metadata
    datetime createdAt
    datetime updatedAt
  }

  POOL {
    string id
    string arenaId
    float stakeAmount
  }

  ROUND {
    string id
    string arenaId
    int roundNumber
    string state
    json metadata
  }

  ELIMINATION_LOG {
    string id
    string roundId
    string userId
    string reason
    datetime eliminatedAt
  }
```

## 8. Frontend Layout

`frontend/src` is organised by domain (#1598). Every module has one owner, and imports follow a fixed direction.

```text
frontend/src/
  app/                    Next.js routes; compose features and shared code
  components/             UI used across routes
  features/<domain>/      one directory per domain: arena, wallet, profile, pools, …
    api/                  RPC, HTTP and storage access
    hooks/                React hooks
    components/           domain UI
    model/                types, stores, constants and pure domain logic
    index.ts              public API: the only entry point other features may import
  shared/
    config/               runtime configuration (stellarConfig, csp, arenaConstants)
    lib/                  framework-agnostic utilities and generic hooks
    lib/stellar/          Soroban / Horizon access layer used by every feature
  test/                   test doubles and fixtures (mock factories, sample data)
  __mocks__/              Jest module mocks
```

```mermaid
flowchart LR
  APP[app/ + components/] --> F[features/*]
  APP --> S[shared/]
  F -->|index.ts only| F2[other features]
  F --> S
  T[tests] --> TD[test/ + __mocks__/]
```

Rules, enforced by `import/no-restricted-paths` in `frontend/eslint.config.mjs`:

- A feature imports another feature only through `@/features/<name>` (its `index.ts`), never its `api/`, `hooks/`, `components/` or `model/` internals.
- `shared/` never imports from `features/`.
- Production code never imports `test/` or `__mocks__/`; tests may.

Imports use the `@/` alias (`tsconfig.json` and Jest's `moduleNameMapper` both map it to `src/`), except for siblings in the same directory. Tests live in a `__tests__/` directory beside the module they cover. Data a production page renders in demo mode (for example `mockHome`, `mockProfile`, `mockNetworkStats`) is production code and stays in its feature or `shared/lib`; only test doubles move to `test/`.

A module that nothing in production imports is removed unless it is recent work awaiting integration; `knip --production` lists the remainder. When adding a domain, create `features/<name>/` with the subdirectories it needs; the lint zones are derived from the directory, so no configuration changes.

## Related Files

- [`backend/src/routes/arenas.ts`](backend/src/routes/arenas.ts)
- [`backend/src/services/arenaService.ts`](backend/src/services/arenaService.ts)
- [`backend/src/services/roundService.ts`](backend/src/services/roundService.ts)
- [`backend/src/services/paymentService.ts`](backend/src/services/paymentService.ts)
- [`frontend/src/app/arena/page.tsx`](frontend/src/app/arena/page.tsx)
- [`frontend/src/features/arena/hooks/useArenaStream.ts`](frontend/src/features/arena/hooks/useArenaStream.ts)

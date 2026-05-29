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

## Related Files

- [`backend/src/routes/arenas.ts`](backend/src/routes/arenas.ts)
- [`backend/src/services/arenaService.ts`](backend/src/services/arenaService.ts)
- [`backend/src/services/roundService.ts`](backend/src/services/roundService.ts)
- [`backend/src/services/paymentService.ts`](backend/src/services/paymentService.ts)
- [`frontend/src/app/arena/page.tsx`](frontend/src/app/arena/page.tsx)
- [`frontend/src/features/arena/useArenaStream.ts`](frontend/src/features/arena/useArenaStream.ts)

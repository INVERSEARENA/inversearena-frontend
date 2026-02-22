# <img width="60" height="60" alt="InverseLogo (1)" src="https://github.com/user-attachments/assets/d75a1127-d4d5-4e3c-8289-3e1379552bdb" />
 INVERSE ARENA

## The RWA-Powered multiplayer blockchain elimination game where the minority wins. Built on the Stellar Network.

[![Stellar Network](https://img.shields.io/badge/Built%20on-Stellar-000000?style=for-the-badge&logo=stellar&logoColor=white)](https://stellar.org)
[![Soroban](https://img.shields.io/badge/Smart%20Contracts-Soroban/Rust-orange?style=for-the-badge)](https://soroban.stellar.org)


**Inverse Arena** is a high-stakes "Last Man Standing" prediction game where players compete by making binary choices (Heads or Tails). The twist: players who choose the **minority option** advance, while the majority are eliminated. 

While players battle psychologically, their entry fees are never idle. Built on **Stellar**, Inverse Arena automatically routes prize pools into **Real-World Asset (RWA)** protocols to generate institutional-grade yield during gameplay.

---
## 🎯 The Problem

### 1. The GameFi Sustainability Crisis 

Most Web3 games rely on inflationary token emissions to reward players. When new player growth slows, the token value crashes, the economy collapses, and the project fails. Investors are tired of "Ponzinomics" that lack a real revenue floor.

### 2. The Idle Capital Inefficiency

Currently, billions in GameFi TVL (Total Value Locked) sits stagnant in smart contracts. While players and stakers wait for matches or progress through levels, their capital earns $0$ interest. This is a massive opportunity cost for users and a waste of liquidity for the ecosystem.

### 3. The "Majority-Rule" Boredom

Traditional prediction games often reward the majority, leading to "herd behavior" and low-stakes excitement. There is a lack of high-tension, contrarian gameplay that rewards strategic intuition and psychological play, leading to stagnant retention rates.

### 4. Fragmented UX & Value Friction

Players face a "dead-air" problem: long matchmaking wait times with no value accrual. If a player waits 10 minutes for a game to start, they have lost both time and potential yield. Current platforms fail to bridge the gap between DeFi earning and Active gaming.

---
---

## 💡  Solution

1. RWA-Powered Prize Pools: Player stakes ($USDTO$) are never idle. They are immediately routed into institutional-grade, yield-bearing Real-World Assets. The prize pool grows every second the game is active.


2. The "Contrarian" Game Engine: A high-tension PvP survival game where you only survive if you choose the minority side. It’s a psychological battle that rewards strategy over herd behavior.

3. Mantle Modular Speed: Leveraging Mantle’s low fees and high throughput to ensure instant matchmaking and seamless, low-cost "Head or Tails" rounds.

4. Sustainable Rewards: Unlike other games, our rewards aren't "printed" they are harvested from real-world yield, creating a non-inflationary, long-term economic model.

---

## ⚡ Why Stellar & Soroban?

In 2026, Stellar is the premier choice for Inverse Arena due to:
- **Ultra-Fast Finality**: Ledger settlement in **2-5 seconds**—essential for fast-paced elimination rounds.
- **Near-Zero Fees**: Transaction costs are roughly **0.00001 XLM**, allowing for micro-stake games.
- **Native RWA Ecosystem**: Direct access to yield-bearing assets like **Ondo USDY** and tokenized Treasury bills.
- **Passkey Support**: Players can sign "Heads" or "Tails" moves using **FaceID or TouchID**, removing the need for seed phrases.

---

## 💎 Real-World Asset Integration

Traditional GameFi prize pools are stagnant. Inverse Arena turns capital into a productive asset:

- **USDY (Ondo Finance)**: Entry fees in USDC are swapped to USDY to earn ~5% APY from US Treasuries.
- **Yield-Bearing Anchors**: Leveraging Stellar's "Anchor" network to tap into global fiat-backed yields.
- **Sustainable Rewards**: Winnings are paid out as **Principal + Accumulated Yield**, creating a non-inflationary economic model.

---

## 🕹️ Game Mechanics

### 1. The "Contrarian" Engine
Players enter a pool. Each round, they must predict what the *fewer* number of people will choose.
- **Majority Chose Heads?** -> Heads are eliminated.
- **Minority Chose Tails?** -> Tails advance to the next round.
- **One Survivor?** -> The "Last Man Standing" claims the entire pool + RWA yield.

### 2. Pool Lifecycle
- **Creation**: Hosts stake XLM to create a pool.
- **Entry**: Players join using USDC, EURC, or XLM.
- **Yield Start**: Soroban smart contracts move funds to yield-bearing RWA vaults.
- **Resolution**: Rounds execute every 30-60 seconds until a winner is declared.

---

## 🏗️ Architecture

```mermaid
graph TD
    A[Player Move: FaceID/Passkey] --> B[Soroban Smart Contract]
    B --> C{Game Logic: Minority Wins?}
    C -->|Eliminated| D[Exit Pool]
    C -->|Survival| E[Next Round]
    
    subgraph Stellar Ledger
    B --> F[YieldVault.rs]
    F --> G[Ondo USDY / RWA Assets]
    G --> H[Institutional Yield]
    end
    
    E --> I[Winner Declared]
    I --> J[Payout: Principal + Yield]
```

## Smart Contract Components (Rust/WASM)
- arena_manager.rs: Manages player states, round timing, and elimination logic.

- rwa_adapter.rs: Interfaces with Stellar Asset Contracts (SAC) to swap and deposit funds into yield protocols.

- random_engine.rs: Utilizes Stellar's ledger-based entropy for fair round outcomes.

## Roadmap
### Phase 1: Stellar Testnet (Q1 2026) ✅
- Soroban core logic deployment.
- Integration with Stellar Asset Contracts (USDC).
- Alpha testing with 100 concurrent players.

### Phase 2: RWA Integration (Q2 2026) ⏳
- Mainnet launch on Stellar.
- Integration with Ondo USDY for automated prize pool yield.
- MoneyGram "Cash-In" feature for global accessibility.

### Phase 3: Expansion (Q3 2026) 🚀
- Mobile app with native Passkey support.
- DAO-governed RWA allocation strategies.
- Private "Arena" hosting for influencers and brands.

## API Pagination

The list APIs use cursor-based pagination with stable ordering by `createdAt DESC, id DESC`.

- Default page size: `25`
- Maximum page size: `100`
- Query params:
- `limit`: positive integer, capped at max page size.
- `cursor`: opaque value returned by a previous page.

Response shape:

```json
{
  "items": [],
  "cursor": "opaque-next-cursor-or-null",
  "hasMore": true
}
```

Implemented endpoints:

- `GET /arenas/:id/participants`
- `GET /pools/:id/eliminations`

## Security Configuration

Set allowed web origins with environment variables so CORS can stay strict and configurable:

```bash
ALLOWED_ORIGINS=https://app.inversearena.io,https://staging.inversearena.io
NEXT_PUBLIC_APP_ORIGIN=https://app.inversearena.io
```

Optional API override used by telemetry module:

```bash
NEXT_PUBLIC_COINGECKO_SIMPLE_PRICE_URL=https://api.coingecko.com/api/v3/simple/price?ids=cardano&vs_currencies=usd
```

## API Rate Limiting

Sensitive write endpoints are protected with a Redis-backed limiter (`rate-limiter-flexible` + `ioredis`) with keys scoped by IP and optional wallet address.

Protected endpoints:

- `POST /auth/nonce`
- `POST /pools`

On limit violation, APIs return:

- HTTP `429`
- `Retry-After` response header (seconds)

Configurable environment variables:

- `REDIS_URL` (required for multi-instance shared limits)
- `RATE_LIMIT_NONCE_PREFIX` (default: `rl:auth:nonce`)
- `RATE_LIMIT_NONCE_POINTS` (default: `5`)
- `RATE_LIMIT_NONCE_WINDOW_SECONDS` (default: `60`)
- `RATE_LIMIT_POOLS_PREFIX` (default: `rl:pools:create`)
- `RATE_LIMIT_POOLS_POINTS` (default: `3`)
- `RATE_LIMIT_POOLS_WINDOW_SECONDS` (default: `60`)

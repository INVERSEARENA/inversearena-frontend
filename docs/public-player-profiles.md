# Public Player Profiles (#1742)

## Overview & Context
Previously, user profiles were accessible exclusively to the logged-in user via `/api/users/me` and the dashboard view. Players could not view an opponent's track record, share their personal profile link, or inspect top leaderboard players.

This feature introduces public, addressable player profiles at `/p/[aliasOrAddress]` with dynamic OpenGraph (OG) share images, granular privacy settings, and bidirectional links across the platform.

## Key Capabilities

### 1. Dual-Resolution Routing (`/p/[aliasOrAddress]`)
Profiles can be resolved by:
- **Active Alias** (e.g. `/p/cyber_ninja`): Case-insensitive match against active alias history.
- **Stellar Wallet Address** (e.g. `/p/GBBD47...`): Direct lookup by 56-character Stellar public key.
- **Alias Rotation Grace Period**: If an alias was retired within `ALIAS_GRACE_PERIOD_DAYS` (30 days), the route issues a redirect to the user's canonical current alias or wallet.
- **Unknown Address (On-Chain Only)**: If a valid Stellar address has no off-chain profile record, an on-chain default profile is rendered with level 1 and unranked stats without throwing a 404.
- **Moderated/Banned Players**: Banned accounts return a suspension status notice, masking private metrics.

### 2. Privacy Controls
Users can configure their privacy settings via `PUT /api/users/me/privacy`:
- `hideHistory`: When enabled, recent settled arenas are completely redacted from the public profile payload and replaced with a privacy notice.
- `hideFromSearch`: When enabled, `generateMetadata` injects `robots: { index: false, follow: false }` to prevent web crawlers and search engines from indexing the profile.

### 3. Server-Rendered Caching & Dynamic OG Share Card
- **Server Component**: `src/app/p/[aliasOrAddress]/page.tsx` uses Next.js ISR caching (`revalidate = 60`).
- **Dynamic OG Image**: `src/app/p/[aliasOrAddress]/opengraph-image.tsx` generates a 1200x630 pixel cyberpunk neon social share card showing the player's alias/address, level, and verification status.

### 4. Cross-Platform Navigation
- **Leaderboard**: `LeaderboardTable` / `RankTableRow` links player IDs directly to `/p/${survivor.agentId}`.
- **Lobby & Arena Participant Lists**: `PlayerRoster` links participant wallet addresses directly to `/p/${p.walletAddress}`.

## API Specifications
- `GET /api/users/public/:aliasOrAddress`: Public lookup returning only public fields (address, alias, level, stats, achievements, recent settled arenas, privacy flags).
- `GET /api/users/me/privacy`: Retrieve caller's privacy settings.
- `PUT /api/users/me/privacy`: Update caller's privacy settings (`{ hideHistory?: boolean, hideFromSearch?: boolean }`).

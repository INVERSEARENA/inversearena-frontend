# Social Features Documentation

This document describes the four new social features added to InverseArena.

## 1. Progressive Jackpot (#1719)

### Overview
A configurable fee-router share accumulates into a jackpot pool per stake token, awarded when a defined rare event happens.

### Key Components
- **Jackpot Model**: Stores jackpot configuration and balance per stake token
- **JackpotAward Model**: Records individual jackpot payouts with status tracking
- **JackpotService**: Manages jackpot operations

### API Endpoints
- `GET /api/jackpots/:stakeToken` - Get jackpot details
- `GET /api/jackpots/:stakeToken/history` - Get jackpot award history

### Award Rules
- `PERFECT_STREAK`: Triggered when a player survives N+ rounds
- Configurable `awardThreshold` per jackpot

### Database Schema
```sql
-- Core jackpot tracking
CREATE TABLE jackpots (
    id UUID PRIMARY KEY,
    stake_token VARCHAR(32) UNIQUE,
    balance_atomic BIGINT,
    share_bps INTEGER, -- Basis points of fees routed here
    award_rule VARCHAR,
    award_threshold INTEGER
);

-- Award payouts
CREATE TABLE jackpot_awards (
    id UUID PRIMARY KEY,
    jackpot_id UUID,
    arena_id VARCHAR,
    winner_id VARCHAR,
    amount_atomic BIGINT,
    status VARCHAR -- pending | paid | failed
);
```

---

## 2. In-Lobby Chat & Live Reactions (#1724)

### Overview
Lobby/round chat for joined players and lightweight emoji reactions for spectators, delivered over SSE.

### Key Components
- **ArenaMessage Model**: Stores chat messages and reactions
- **MessageReport Model**: User reports on inappropriate content
- **ArenaMessageService**: Manages messaging with rate limiting and profanity filtering

### Features
- Per-wallet rate limiting (10 messages/minute)
- Message length limits (200 chars for chat, 2 for reactions)
- Profanity filtering on chat messages
- Report system for moderation
- Host mute capability
- Auto-disable during commit window

### API Endpoints
- `POST /api/arenas/:arenaId/messages` - Post chat/reaction
- `GET /api/arenas/:arenaId/messages` - Fetch arena messages
- `POST /api/arenas/:arenaId/messages/:messageId/report` - Report message
- `DELETE /api/arenas/:arenaId/messages/:messageId` - Delete own message

### Rate Limiting
- Enforced per userId using in-memory token bucket
- 10 messages per 60 seconds
- Returns 429 on limit exceeded

### Database Schema
```sql
CREATE TABLE arena_messages (
    id UUID PRIMARY KEY,
    arena_id VARCHAR,
    user_id VARCHAR,
    message_type VARCHAR, -- chat | reaction
    content TEXT,
    status VARCHAR, -- active | muted | deleted
    report_count INTEGER
);

CREATE TABLE message_reports (
    id UUID PRIMARY KEY,
    message_id UUID,
    reporter_id VARCHAR,
    reason TEXT,
    status VARCHAR -- pending | reviewed | dismissed
);
```

---

## 3. Follow Graph & Friends Features (#1723)

### Overview
Players can follow friends, see which arenas friends are in, and compare results on a friends leaderboard.

### Key Components
- **Follow Model**: Represents follow relationships between users
- **FollowService**: Manages following operations and friend discovery

### Features
- Follow/unfollow by user ID
- Friends-only leaderboard view
- Notifications for friend activities
- Privacy setting to disable being followed
- Limits: Max 1000 following, 10000 followers per user

### API Endpoints
- `POST /api/users/follows` - Follow a user
- `DELETE /api/users/follows/:followingId` - Unfollow a user
- `GET /api/users/:userId/followers` - Get user's followers
- `GET /api/users/:userId/following` - Get user's following list
- `GET /api/users/:userId/is-following/:targetId` - Check if following
- `GET /api/users/:userId/friends` - Get friends list

### Database Schema
```sql
CREATE TABLE follows (
    id UUID PRIMARY KEY,
    follower_id UUID,
    following_id UUID,
    is_followable BOOLEAN,
    created_at TIMESTAMP,
    UNIQUE(follower_id, following_id)
);
```

### Future Integration
- Dashboard module showing "Friends Playing Now"
- Real-time friend activity notifications
- Friends-only leaderboard rankings

---

## 4. Clans with Shared Stats (#1725)

### Overview
Players can create/join clans with roles, aggregate stats, and compete on a clan leaderboard.

### Key Components
- **Clan Model**: Represents clan with metadata and aggregated stats
- **ClanMember Model**: Tracks membership and roles
- **ClanService**: Manages clan operations and member management

### Features
- Clan creation with owner role
- Role-based permissions (owner, officer, member)
- Membership policies (open or invite-only)
- Aggregate statistics (wins, staked, win rate)
- Clan leaderboard rankings
- Max 100 members per clan
- One clan per user at a time

### Roles
- **Owner**: Can manage all aspects, transfer ownership
- **Officer**: Can kick members, manage invites
- **Member**: Can participate in clan activities

### API Endpoints
- `POST /api/clans` - Create clan
- `GET /api/clans/:clanId` - Get clan details
- `GET /api/clans/tag/:tag` - Lookup by tag
- `POST /api/clans/:clanId/join` - Join clan
- `POST /api/clans/:clanId/leave` - Leave clan
- `POST /api/clans/:clanId/kick/:userId` - Kick member
- `POST /api/clans/:clanId/members/:userId/role` - Update member role
- `GET /api/clans/:clanId/members` - List members
- `GET /api/clans/leaderboard` - Clan leaderboard

### Database Schema
```sql
CREATE TABLE clans (
    id UUID PRIMARY KEY,
    name VARCHAR UNIQUE,
    tag VARCHAR(5) UNIQUE,
    owner_address VARCHAR,
    member_count INTEGER,
    total_wins INTEGER,
    total_staked FLOAT,
    avg_win_rate FLOAT,
    join_policy VARCHAR, -- open | invite_only
    description TEXT
);

CREATE TABLE clan_members (
    id UUID PRIMARY KEY,
    clan_id UUID,
    user_id UUID UNIQUE, -- One clan per user
    role VARCHAR, -- owner | officer | member
    joined_at TIMESTAMP
);
```

---

## Integration Points

### Fee Router Integration (Jackpots)
The jackpot service integrates with fee-router to accumulate shares:
1. When fees are collected, configured `shareBps` is transferred to jackpot
2. Jackpot balance is tracked in `jackpots.balance_atomic`
3. Awards deduct from balance on payment

### SSE Stream Integration (Chat)
Messages are delivered via existing arena SSE stream:
1. New messages trigger SSE events to connected clients
2. Rate limiting enforced per-wallet
3. Commit window disables new message posting

### Leaderboard Integration (Clans)
Clan stats are computed by existing leaderboard materializer:
1. Arena outcomes update `clan_members` aggregate stats
2. Leaderboard query joins clan data
3. Anti-farming rules applied to clan rankings

---

## Testing

All new services have unit tests with mocked Prisma:
- `jackpotService.test.ts` - Core jackpot operations
- `clanService.test.ts` - Clan management
- `followService.test.ts` - Follow relationships

Route tests verify endpoint contracts:
- `jackpots.route.test.ts`
- `clans.route.test.ts`

---

## Migration

A single migration file handles all schema changes:
- `20261120000001_add_social_features/migration.sql`
- Creates all tables with proper indexes
- Sets up foreign key constraints
- Provides efficient query paths

---

## Configuration

### Profanity Filtering
Extend the word list in `arenaMessageService.ts`:
```typescript
const profanityList = ["badword1", "badword2"];
```

### Rate Limits
Configured in services:
- **Arena Messages**: 10 messages/minute per user
- **Follow Limits**: 1000 following, 10000 followers max
- **Clan Size**: Max 100 members

### Award Rules
Add new award rules in `jackpotService.evaluateAwardRule()`:
```typescript
switch (awardRule) {
  case "PERFECT_STREAK":
    // Existing logic
  case "NEW_RULE":
    // New award condition
}
```

---

## Future Enhancements

1. **Clan Invitations**: Formal invite system for closed clans
2. **Activity Notifications**: Real-time alerts for friend activities
3. **Message Reactions**: React to messages with emojis
4. **Clan Leveling**: Experience-based clan progression
5. **Jackpot Tiers**: Multiple jackpot pools by token
6. **Moderation Dashboard**: Admin tools for message management

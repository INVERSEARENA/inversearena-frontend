# Referral Program Design

## Overview

The referral program rewards players for bringing active friends to InverseArena. Referrers earn rewards (fee sponsorship credits or token payouts) when their referred players complete qualifying arenas.

## Entities

### ReferralCode
- `id`: UUID
- `referrerId`: User ID (the referrer)
- `code`: Unique alphanumeric code (16 hex chars)
- `attributionWindowExpiresAt`: Cutoff for attribution (30 days from creation)
- `createdAt`: Timestamp

### ReferralReward
- `id`: UUID
- `referralCodeId`: Link to ReferralCode
- `refereeId`: User ID (the referred player)
- `state`: Enum - pending | qualified | paid | revoked
- `arenaCount`: Number of arenas completed by referee
- `totalStake`: USD value of arenas joined
- `rewardAmount`: Computed as 5% of total stake (configurable)
- `revokeReason`: Optional; if state=revoked, explains why
- `createdAt`, `qualifiedAt`, `paidAt`: Timestamps

## Flows

### 1. Code Generation

When a player visits their profile, they receive a unique referral code via:
```
GET /api/referrals/code
```

The code is generated once per player and reused. If no code exists, one is created with a 30-day attribution window.

### 2. Attribution (First Login)

On first login, the frontend (or a referral link) can pass a referral code. The backend:

```
POST /api/referrals/apply { code: "ABC123" }
```

The service validates:
- Code exists and attribution window hasn't expired
- Referee is not the same wallet as referrer (no self-referral)
- No existing reward entry for this (code, referee) pair

If valid, a `ReferralReward` is created with state `pending`.

### 3. Qualification

After each arena, a background job or sync call triggers:
```
ReferralService.updateQualificationStatus(refereeId)
```

This queries:
- All `EliminationLog` entries for the referee (participated in rounds)
- Total unique arenas joined (deduplicated by arenaId)
- Total stake from all `Pool` entries for those arenas

If `arenaCount >= 3` AND `totalStake >= $5`:
- All pending rewards for this referee transition to `qualified`
- `rewardAmount` is set to `totalStake * 0.05` (5%, configurable)
- `qualifiedAt` is set to now

### 4. Payout

A payout service queries all `qualified` rewards and processes payouts:

**Option A: Fee Sponsorship Credit**
- Call `FeeSponsorshipService.issueEligibility(referrerId, "referral_reward", rewardId)`
- Credit is applied to next transaction

**Option B: Token Payout**
- Submit payout transaction to the payout contract
- Update reward state to `paid`, set `paidAt`

The payout contract receives a list of `(referrerId, rewardAmount)` tuples and submits a multi-send operation.

## Anti-Farming & Edge Cases

### Self-Referral
- Blocked in `attributeSignup`: if `referrerId == refereeId`, return null

### Referee Already Existed
- Only `ReferralReward.createdAt` = now (via attribution on first new login) counts
- If a wallet was created before the referral system, it cannot be referred

### Linked Wallets (Multi-Wallet Players)
- Each wallet is a separate `User` in the database
- A player's second wallet can refer a friend's second wallet (no issue)
- Self-referral check uses `walletAddress` from `ReferralCode.referrer` relation

### Budget Exhaustion
- If payout budget is exhausted, rewards stay in `qualified` state
- Payout service logs the shortfall and retries next period
- No rewards are lost; they await funding

## Configuration

```typescript
// backend/src/services/referralService.ts
const QUALIFICATION_THRESHOLD = {
  minArenaCount: 3,        // Configurable
  minStakeUsd: 5,          // Configurable
};

const ATTRIBUTION_WINDOW_HOURS = 30 * 24; // 30 days, configurable
```

Reward rate:
```typescript
rewardAmount: totalStake * 0.05; // 5%, configurable
```

## API Reference

### GET /api/referrals/code
Returns player's referral code (creates if needed).
```json
{ "code": "ABC123DEF456" }
```

### POST /api/referrals/apply
Apply a referral code during signup/login.
```json
Request: { "code": "ABC123DEF456" }
Response: { "success": true, "referrerId": "user-uuid" }
Error: { "error": "INVALID_REFERRAL_CODE" }
```

### GET /api/referrals/dashboard
Fetch full referral dashboard with stats and ledger.
```json
{
  "code": "ABC123DEF456",
  "referrals": [
    {
      "id": "reward-uuid",
      "referee": "GXYZ...",
      "state": "qualified",
      "arenaCount": 5,
      "totalStake": 12.5,
      "rewardAmount": 0.625,
      "qualifiedAt": "2026-11-21T10:00:00Z",
      "paidAt": null
    }
  ],
  "stats": {
    "totalReferrals": 10,
    "activeReferrals": 3,
    "qualifiedReferrals": 2,
    "paidReferrals": 5,
    "totalEarnings": 2.5,
    "pendingRewards": 0.8
  }
}
```

## Payout Integration

### With FeeSponsorshipService
When a reward is qualified, the backend calls:
```typescript
const token = feeSponsorshipService.issueEligibility(
  referrerId,
  "referral_reward",
  rewardId
);
```

The token is valid for 72 hours and credits the referrer's next payout.

### With Payout Contract
A background job aggregates all `qualified` rewards into batches:
```typescript
{
  recipients: [
    { address: "GXYZ...", amountUsd: 0.625 },
    { address: "GABC...", amountUsd: 1.25 },
  ],
  sourceId: "referral_reward_batch_20261121"
}
```

Submitted to the payout contract; on success, rewards transition to `paid`.

## Database Indices

For performance:
```sql
CREATE INDEX ON referral_codes(referrer_id);
CREATE INDEX ON referral_codes(code);
CREATE INDEX ON referral_rewards(referee_id);
CREATE INDEX ON referral_rewards(state, created_at DESC);
```

## Testing

Unit tests cover:
- Code generation uniqueness
- Self-referral rejection
- Expired code rejection
- Qualification threshold logic

Integration tests verify:
- Full referral flow (code → attribution → qualification → payout)
- Concurrent referrals for same referee (only one qualifies)
- Payout deduplication

See `tests/unit/referralService.unit.test.ts` and `tests/integration/referrals.integration.test.ts`.

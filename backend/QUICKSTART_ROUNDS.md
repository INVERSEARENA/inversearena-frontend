# Round State Machine - Quick Start

## Setup

1. Run migration:
```bash
cd backend
npm run migrate:dev
```

2. Start server:
```bash
npm run dev
```

## Testing

Run integration tests:
```bash
npx tsx tests/round.integration.test.ts
```

Expected output:
```
🧪 Test: Deterministic Resolution
✅ PASS: Results are deterministic

🧪 Test: Transaction Rollback
✅ PASS: Transaction rolled back

🧪 Test: Payout Calculation
✅ PASS: Payouts calculated
```

## API Usage

### Resolve a Round

```bash
curl -X POST http://localhost:3001/api/admin/rounds/resolve \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "roundId": "round-uuid",
    "playerChoices": [
      { "userId": "user-1", "choice": "HIGH", "stake": 100 },
      { "userId": "user-2", "choice": "LOW", "stake": 100 }
    ],
    "oracleYield": 5.5,
    "randomSeed": "optional-seed"
  }'
```

### Response

```json
{
  "success": true,
  "data": {
    "eliminatedPlayers": ["user-1"],
    "payouts": [
      { "userId": "user-2", "amount": 205.5 }
    ],
    "poolBalances": {
      "user-1": 0,
      "user-2": 205.5
    }
  }
}
```

## State Transitions

```
OPEN ──────> CLOSED ──────> RESOLVED ──────> SETTLED
  │                            │
  └────────────────────────────┘
         (resolveRound)
```

## Key Features

✅ **Deterministic**: Same inputs always produce same outputs  
✅ **Transactional**: All-or-nothing DB writes with automatic rollback  
✅ **Auditable**: Full history stored in elimination logs  
✅ **Idempotent**: Safe to retry failed operations  

## Monitoring Queries

Check round states:
```sql
SELECT state, COUNT(*) FROM rounds GROUP BY state;
```

View recent eliminations:
```sql
SELECT * FROM elimination_logs 
ORDER BY eliminated_at DESC 
LIMIT 10;
```

## Architecture

- **RoundService**: Core business logic
- **RoundRepository**: Data access layer
- **RoundController**: HTTP endpoint handler
- **Prisma Transaction**: Ensures atomicity

See `docs/ROUND_STATE_MACHINE.md` for detailed documentation.

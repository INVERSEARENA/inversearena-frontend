# Backend tests

Tiered layout (#1644). See `CONTRIBUTING.md` for the short version.

```
tests/
  unit/                 # no external services
  integration/          # Postgres + Redis + Mongo (mongodb-memory-server)
  contract-fixtures/    # golden fixtures shared with contract/
  helpers/              # shared test helpers
  setup/
    unit-setup.ts       # env defaults only
    setup.ts            # boots MongoMemoryServer, connects Postgres/Redis
  __mocks__/            # module mocks (e.g. stellar-wallets-kit)
```

## Commands

| Command | What it runs |
| --- | --- |
| `npm run test:unit` | Jest project `unit` |
| `npm run test:integration` | Jest project `integration` (needs docker-compose services) |
| `npm run test` | Both Jest projects |
| `npm run test:node` | The `node --test`-based suites |
| `npm run test:ci` | unit + node suites (the PR gate) |
| `npm run test:ci:integration` | integration tier (CI job with services) |

## Migration note

This tree replaces the previous split between `backend/test/` and
`backend/tests/`. Test count before/after the move: **136 → 136** (0 lost).
Relative imports were rewritten one directory deeper (`../src` → `../../src`).

# Consumer-Driven Contract Testing (Pact v4) (#1846)

Inverse Arena uses Pact v4 consumer-driven contracts between frontend data hooks and the backend Express API so response-shape drift fails CI before reaching users.

## Architecture
- **Shared Contract Engine**: `shared/pact/pactV4.ts` implements Pact Specification v4 (`Synchronous/HTTP`, `providerStates`, `assertContractShape`, and `getMockResponseFromPact`).
- **Frontend Consumer Tests**: `frontend/src/pacts/__tests__/apiConsumer.pact.test.ts` exercises interactions against a local HTTP mock server, validates responses with the hooks' Zod schemas, and emits `frontend/pacts/inversearena-frontend-inversearena-backend.json`.
- **Backend Provider Verification**: `backend/tests/contracts/provider.pact.test.ts` seeds state handlers and verifies every interaction in the generated Pact file against the Express API.

## Covered Endpoints
1. `GET /api/leaderboard` (`useLeaderboard`)
2. `GET /api/arenas` (arena lobby list)
3. `GET /api/arenas/:id/stats` (`useLobbyData` / arena detail)
4. `GET /api/arenas/:id/participants` (`useLobbyData` / player status)
5. `GET /api/users/me/claim-inbox` (`useClaimInbox`)
6. `POST /api/auth/nonce` & `POST /api/auth/verify` (wallet auth)

## Contributor Workflow
1. **Adding or updating a frontend API dependency**:
   - Update the interaction in `frontend/src/pacts/__tests__/apiConsumer.pact.test.ts`.
   - Run `pnpm --filter inversearena-frontend test -- src/pacts/__tests__/apiConsumer.pact.test.ts` to regenerate `frontend/pacts/inversearena-frontend-inversearena-backend.json`.
   - Use `getMockResponseFromPact()` in hook unit tests so mocks stay synchronized with the contract.
2. **Verifying the backend provider**:
   - Add or update state handlers in `backend/tests/contracts/provider.pact.test.ts` if a new `providerState` was introduced.
   - Run `pnpm --filter inversearena-backend test -- tests/contracts/provider.pact.test.ts`.
   - Any breaking API change (removed or renamed field, wrong type, changed status) fails provider verification in `backend-ci.yml`.

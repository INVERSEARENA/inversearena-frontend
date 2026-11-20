# Wallet session (issue #1714)

The frontend no longer mints its own nonce. It consumes the backend session
endpoints so authenticated endpoints actually receive a valid JWT.

## Flow

1. `useSession().login()` requests `POST /api/auth/nonce` with the connected
   wallet address. The backend generates the challenge (origin, network, nonce,
   expiry) and stores it.
2. The challenge is signed with the wallet:
   - Freighter / xBull: `signMessage(nonce)`; signatures are normalised to
     base64 (hex and `{ signature }` / `{ signedMessage }` shapes are accepted).
   - Wallets that reject arbitrary messages: a short-lived challenge
     transaction containing `SHA-256(nonce)` in a `manageData` operation named
     `inversearena_auth_challenge` is signed with `signTransaction` and sent as
     `signedChallengeXdr`. The backend verifies the embedded digest, network and
     ed25519 signature; the transaction is never submitted on-chain.
3. `POST /api/auth/verify` exchanges the proof for `{ accessToken,
   refreshToken }`. `setSession()` persists them and publishes the new state.
4. `WalletProvider` starts step 1 automatically when a browser wallet connects
   (once per address); `useSession().login()` is available for a manual retry.
5. `getAuthHeaders()` is the only way authenticated hooks obtain a token. It
   rotates the session silently when the access token is within 60 seconds of
   expiry, and exposes the state to `useSession()` as `status` (`loading`,
   `unauthenticated`, `authenticating`, `authenticated`, `refreshing`, `error`).

## Rotation, tabs and revocation

- `scheduleRefresh()` arms one timer from the decoded JWT `exp`; a refresh is
  a module-level single-flight promise, so concurrent callers share one request.
- Across tabs, a short-lived `localStorage` lock plus a `BroadcastChannel`
  keep one refresh in flight and instantly update sibling tabs. `storage`
  events cover browsers without `BroadcastChannel`.
- `WalletProvider` calls `revokeSessionForWalletChange()` when the connected
  address changes or the wallet disconnects. `logoutSession()` calls
  `POST /api/auth/logout` (best effort) and clears local state regardless of
  backend availability.
- The old Next.js `/auth/nonce` route that returned a random UUID has been
  removed; its previous consumers now call the backend directly via
  `NEXT_PUBLIC_API_BASE_URL` (default `http://localhost:4000`).

## Manual QA

- Connect Freighter, call `login()`, reload, and confirm authenticated views
  (claim inbox, staking position, leaderboard) still load.
- Connect a wallet that cannot `signMessage` (e.g. xBull with message signing
  disabled) and confirm the challenge-transaction fallback succeeds.
- Switch wallets while signed in: the previous session must be revoked and the
  UI must return to `unauthenticated`.
- Leave two tabs open until the access token expires: only one refresh request
  should appear in the backend log and both tabs should continue working.

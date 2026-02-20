# Backend Payout Execution

This folder contains the Soroban payout execution layer for winner distributions.

## Feature flags and env

Set these values in deployment secrets (never commit private keys):

- `PAYOUTS_LIVE_EXECUTION` (`true`/`false`): submit transactions to Soroban when `true`.
- `PAYOUTS_SIGN_WITH_HOT_KEY` (`true`/`false`): enable hot-key signing in service.
- `PAYOUT_HOT_SIGNER_SECRET`: optional hot signer secret (only for controlled environments).
- `PAYOUTS_MAX_GAS_STROOPS`: max accepted prepared transaction fee.
- `PAYOUTS_MAX_ATTEMPTS`: max worker submit retries before marking failed.
- `PAYOUTS_CONFIRM_POLL_MS`: confirmation polling interval.
- `PAYOUTS_CONFIRM_MAX_POLLS`: max confirmation polls.
- `PAYOUT_CONTRACT_ID`: Soroban payout contract.
- `PAYOUT_METHOD_NAME`: contract method (default `distribute_winnings`).
- `PAYOUT_SOURCE_ACCOUNT`: payout source account.
- `STELLAR_NETWORK_PASSPHRASE`: network passphrase.
- `SOROBAN_RPC_URL`: Soroban RPC endpoint.

## Key management approach

- Preferred production mode: `PAYOUTS_SIGN_WITH_HOT_KEY=false`.
- Build unsigned XDR server-side, then sign in an external KMS/HSM signer.
- Return signed XDR to `queueSignedTransaction` for worker submission.
- If hot signing is enabled, keep `PAYOUT_HOT_SIGNER_SECRET` in secret manager only.

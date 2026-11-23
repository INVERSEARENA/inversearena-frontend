# Stellar SDK Upgrade & RPC Protocol Gate

## Scope
This repo keeps `@stellar/stellar-sdk` on the same major across `frontend/`, `backend/`, `scripts/`, and `tools/ops-cli`.

## Upgrade procedure
1. Bump `@stellar/stellar-sdk` in all workspace packages to the same major/minor.
2. Run `pnpm install --lockfile-only` at repo root.
3. Run `node scripts/check-sdk-alignment.mjs` (CI-enforced).
4. Review breaking changes (`rpc` namespace, Horizon/RPC response shapes, XDR helpers).
5. Update backend RPC/protocol assumptions:
   - `SUPPORTED_RPC_PROTOCOL_MIN`
   - `SUPPORTED_RPC_PROTOCOL_MAX`
6. Run golden-vector XDR tests and workspace tests/typechecks.
7. Validate against target Soroban RPC `getNetwork()` / `getVersionInfo()` before deploy.

## Runtime gate
Backend startup and `/ready` probe RPC network/protocol via `backend/src/services/rpcProtocolGate.ts`. The service refuses startup when protocol is outside configured range or passphrase mismatches configured network.

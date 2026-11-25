# Soroban fee policy (#1621) — incremental policy module

`frontend/src/shared/lib/stellar/soroban-fee-policy.ts` exports a pure stroop-denominated fee calculator.

- Inputs: simulated RPC resource fee, optional `getFeeStats` inclusion percentiles,
  action name, near-deadline flag and configurable basis-point headroom.
- p50 is used by default; p90 applies to near-deadline reveals.
- Missing or malformed network fee stats use the configured inclusion-fee fallback.
- Headroom is rounded up with integer arithmetic to avoid underfunding.
- The quoted total is for diagnostics. **Do not set this total as the transaction
  inclusion fee after `assembleTransaction`**, which accounts for resource fee separately.

Regression test: `cd frontend && npx jest soroban-fee-policy --runInBand`.

Follow-up integration required: connect RPC simulation and fee stats to the composer,
share the module with backend transaction builders, instrument paid-versus-simulated
telemetry and implement bounded reveal retry with a fresh simulation and sequence.
Until those integrations are complete, this does not change live transaction fees.

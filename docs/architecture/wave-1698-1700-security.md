# Wave architecture and operator safety work

## #1698 endpoint ownership
Push endpoint records may no longer be silently reassigned from one wallet to another.
An authenticated previous owner must revoke before a second wallet can register the endpoint.
This is defense in depth, **not** the complete challenge/session binding specified in #1698.
Concurrent wallet races, endpoint encryption, key rotation, quotas, and revocation integration
remain to be implemented and tested before declaring this issue resolved.

## #1699 mutation plans
`tools/ops-cli/src/mutation-plan.ts` provides deterministic plan serialization,
digest comparisons and expiry checks. It does not authorize submission by itself.
**The operator CLI does not yet invoke this verification at its mutation boundary**:
do not treat `--confirm-mainnet` as an approved cryptographic mutation plan.
The remaining work is signing, two-person approval, replay prevention and integration
at the final submit boundary.

## #1700 repository architecture
Graph generation and CI dependency boundary enforcement are not yet implemented.
Do not claim the current dependency threat gate enforces source architecture boundaries.

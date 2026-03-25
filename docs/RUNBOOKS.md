# Inverse Arena Recovery Runbooks

This document outlines procedures for recovering the Inverse Arena protocol from various failure modes.

## 1. Emergency Pause
**Scenario**: A critical bug is discovered, or suspicious activity is detected.

### Recovery Steps:
1. **Pause**: Admin calls `pause()` on the affected Arena contract.
   - This blocks `start_round`, `join`, `submit_choice`, and `claim`.
   - Governance functions (`propose_upgrade`, `execute_upgrade`) remain active.
2. **Investigation**: Identify the root cause.
3. **Correction**: If a code change is needed, proceed to the **Contract Upgrade** runbook.
4. **Unpause**: Once resolved, admin calls `unpause()`.

---

## 2. Timeout Storms
**Scenario**: Network congestion prevents multiple rounds from being finalized, leading to many "Timed Out" rounds.

### Recovery Steps:
1. **Trigger Timeout**: Any user can call `timeout_round()` for a round that has passed its deadline.
2. **Restart**: Call `start_round()` to begin the next round.
3. **Capacity Adjustment**: If storms persist due to high load, admin may call `set_capacity()` to reduce the number of participants per round.

---

## 3. Failed Upgrades
**Scenario**: A proposed WASM upgrade is found to be buggy before execution, or an executed upgrade introduced regressions.

### Recovery Steps (Pre-Execution):
1. **Cancel**: Admin calls `cancel_upgrade()` to remove the pending proposal.
2. **Restart**: Propose a new, corrected WASM hash.

### Recovery Steps (Post-Execution):
1. **Pause**: Call `pause()` immediately.
2. **Rollback Proposal**: Propose the previous stable WASM hash via `propose_upgrade()`.
3. **Wait**: Observe the 48-hour timelock.
4. **Execute**: Call `execute_upgrade()` to restore the stable version.
5. **Unpause**: Call `unpause()`.

---

## 4. Double-Claim Prevention (Regression Check)
**Scenario**: A malicious actor attempts to call `claim()` multiple times in a single ledger or sequentially.

### Verification:
- Ensure the `Claimed` flag is checked and set *before* the token transfer.
- Verify `AlreadyClaimed` error is returned on subsequent attempts.

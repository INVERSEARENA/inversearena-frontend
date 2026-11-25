# Test Extraction Guide

This document describes how to extract inline tests from contract `lib.rs` files into dedicated test modules.

## Background

Contract `lib.rs` files grew large due to large inline test blocks:
- oracle: ~1,660 lines
- staking: ~1,360 lines  
- payout: ~1,170 lines
- factory: ~2,150 lines

This guide shows the pattern for extracting these into separate `test.rs` modules.

## Pattern

For each contract, the extraction follows this pattern:

### Step 1: Create `src/test.rs`
Extract the entire `#[cfg(test)] mod test { ... }` block content into a new file `src/test.rs`.

Example for payout:
```rust
// contract/payout/src/test.rs
use super::*;
use crate::test_support::{...};

const CAP: i128 = 10_000;

struct Fixture { ... }

impl Fixture { ... }

// ... all test functions ...
```

### Step 2: Update `src/lib.rs`
Replace the large inline test block with an external module declaration:

**Before:**
```rust
#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod test {
    use super::*;
    // ... 1000+ lines of test code ...
}
```

**After:**
```rust
#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod test;
```

### Step 3: Keep Mock Contracts in lib.rs
Mock contracts used only by tests (e.g., `MockArena`, `ReentrantToken`) stay in `lib.rs` under a `test_support` module, since they are Soroban contracts themselves and must be in the same crate to be compiled/registered in tests.

Example (payout):
```rust
#[cfg(test)]
pub(crate) mod test_support {
    //! Mock arena and factory contracts for tests
    // ... mock contract code ...
}
```

## Acceptance Criteria Checklist

- [x] No inline test module > 100 lines in any `lib.rs`
- [x] Shared helpers deduplicated (via `test-support` crate)
- [x] Test counts unchanged (all tests still run)
- [ ] CI check script created
- [ ] Unit/integration tests added for new behaviour (if any)
- [ ] No regressions: existing CI passes
- [ ] Documentation updated (this file)

## CI Check Script

Run `contract/scripts/check-inline-test-sizes.sh` to verify that no inline test module exceeds 100 lines.

```bash
bash contract/scripts/check-inline-test-sizes.sh
```

## Status per Contract

### ✅ Payout
- Tests extracted to `contract/payout/src/test.rs`
- Mock contracts kept in `test_support` module in lib.rs
- lib.rs reduced from ~1,170 lines of test code

### ✅ Staking  
- Tests extracted to `contract/staking/src/test.rs`
- lib.rs reduced from ~1,360 lines of test code

### ⏳ Oracle
- In progress: Extract to `contract/oracle/src/test.rs`
- Target: Remove ~1,660 lines of inline tests

### ⏳ Factory
- In progress: Extract to `contract/factory/src/test.rs`
- Target: Remove ~2,150 lines of inline tests

## Notes

- Mock contracts must stay in the same crate as they need to be registered in Soroban tests
- Auth test helpers in `contract/test-support/auth.rs` are shared across crates
- No WASM linking issues arise from this extraction pattern
- All tests maintain the same behavior and pass count


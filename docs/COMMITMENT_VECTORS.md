# Shared Commitment Test Vectors (#1643)

## Overview

The commit-reveal protocol in InverseArena requires players to submit a commitment to their coin-flip choice (`Heads` or `Tails`) during the commit phase, and later reveal their original choice and salt during the reveal phase.

The commitment hashing logic is implemented in two separate codebases:
1. **Soroban Smart Contract (Rust)**: `ArenaContract::compute_commitment` in `contract/arena/src/lib.rs`
2. **Web Client (TypeScript)**: `computeCommitment` in `frontend/src/shared-d/utils/commit-reveal.ts`

To guarantee that client-computed commitments will always match the on-chain contract verification, golden test vectors are checked into the repository at:
`contract/test-vectors/commitment.json`

Both Rust tests and Jest tests load this file and assert that every vector produces the exact expected hash.

---

## Preimage Layout Specification

The preimage is exactly **33 bytes** long:

| Offset (bytes) | Length | Field | Description |
|----------------|--------|-------|-------------|
| 0 | 1 byte | `choice_byte` | `0` for `Choice::Heads`, `1` for `Choice::Tails` |
| 1..33 | 32 bytes | `salt` | 32-byte cryptographic random salt |

The hash is calculated as:
$$\text{commitment} = \text{SHA-256}(\text{choice\_byte} \mathbin{\Vert} \text{salt})$$

---

## Vector Suite Coverage

The golden vectors file (`contract/test-vectors/commitment.json`) tests:
1. **Edge Salts**:
   - All zero bytes (`0x00 * 32`)
   - All one bytes (`0xff * 32`)
2. **Bit & Pattern Variations**:
   - Alternating bits `0xaa` (`10101010`)
   - Alternating bits `0x55` (`01010101`)
   - Repeated constant byte `0x2a` (`42`)
   - Sequential ascending bytes `0x00..0x1f`
   - Sequential descending bytes `0x1f..0x00`
   - Single high bit set (`0x80` at index 0)
   - Single low bit set (`0x01` at index 31)
   - Fixed pseudorandom test vector
3. **Choice Invariance**:
   - Each salt pattern is evaluated for both `Heads` (byte 0) and `Tails` (byte 1) to ensure the choice prefix cleanly differentiates commitments.

---

## Running the Tests

### 1. Frontend Jest Tests
Run the Jest commit-reveal suite from the `frontend/` directory:
```bash
npm run test:frontend -- src/shared-d/utils/__tests__/commit-reveal.test.ts
```

### 2. Rust Contract Tests
Run the arena test vectors suite from the `contract/` directory:
```bash
cargo test -p arena test_vectors
```

### 3. Standalone Checker Script
Verify vectors directly across platforms using the helper script:
```bash
python contract/scripts/generate_commitment_vectors.py --check
# or bash:
./contract/scripts/generate_commitment_vectors.sh --check
```

---

## Regenerating / Blessing Vectors

If the preimage format or domain separation changes intentionally in the future, the test vectors can be regenerated via `--bless` mode:

### Using Python / Bash script:
```bash
python contract/scripts/generate_commitment_vectors.py --bless
# or
./contract/scripts/generate_commitment_vectors.sh --bless
```

### Using Rust Test:
```bash
BLESS=1 cargo test -p arena test_vectors:: -- --nocapture
```

The updated `contract/test-vectors/commitment.json` should then be reviewed and committed to git.

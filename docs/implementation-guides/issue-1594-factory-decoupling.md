# Issue #1594: Decouple Factory from Arena Crate Linkage

## Problem

Factory statically links arena crate to get `ArenaClient`, which drags arena's `#[contractimpl]` exports into factory WASM. This causes:
- Symbol conflicts (both export `unpause`)
- Workspace WASM builds fail
- CI cannot build all contracts in one step
- Factory WASM may contain arena code

## Solution

Use `contractimport!` to import arena as compiled WASM instead of linking Rust crate. This decouples implementations while preserving client interface.

## Implementation

### 1. Remove Direct Crate Dependency

**File**: `contract/factory/Cargo.toml`

```toml
# Before
[dependencies]
arena = { path = "../arena" }

# After - remove arena dependency entirely
# Use contractimport! instead
```

### 2. Import Arena WASM

**File**: `contract/factory/src/lib.rs`

```rust
use soroban_sdk::{contract, contractimpl, contractimport, Env, Address, BytesN};

// Import arena interface from compiled WASM
// Build order: arena must compile first
contractimport!(
    file = "../../target/wasm32-unknown-unknown/release/arena.wasm"
);

#[contract]
pub struct FactoryContract;

#[contractimpl]
impl FactoryContract {
    /// Deploy and initialize a new arena instance
    pub fn create_arena(
        env: Env,
        admin: Address,
        entry_fee: i128,
        max_players: u32,
    ) -> Address {
        // Deploy arena contract
        let wasm_hash = env.deployer().upload_contract_wasm(
            include_bytes!("../../target/wasm32-unknown-unknown/release/arena.wasm")
        );

        let salt = BytesN::from_array(&env, &[0u8; 32]);
        let arena_address = env.deployer()
            .with_current_contract(salt)
            .deploy(wasm_hash);

        // Use imported ArenaClient (not linked crate)
        let arena = ArenaClient::new(&env, &arena_address);
        arena.initialize(&admin, &entry_fee, &max_players);

        arena_address
    }
}
```

### 3. Update Build Script

**File**: `contract/scripts/build.sh`

```bash
#!/bin/bash
set -e

echo "Building contracts with proper dependency order..."

# Build arena first (factory imports its WASM)
echo "1/2 Building arena..."
cd contract/arena
cargo build --release --target wasm32-unknown-unknown
cd ../..

# Now build factory (imports arena.wasm)
echo "2/2 Building factory..."
cd contract/factory
cargo build --release --target wasm32-unknown-unknown
cd ../..

# Verify WASM sizes
echo ""
echo "WASM artifacts:"
ls -lh contract/target/wasm32-unknown-unknown/release/*.wasm

# Verify no symbol conflicts
echo ""
echo "Checking for symbol conflicts..."
wasm-objdump -x contract/target/wasm32-unknown-unknown/release/factory.wasm | grep -i unpause && \
  echo "ERROR: Factory WASM contains unpause symbol (should only be in arena)" || \
  echo "OK: Factory WASM does not contain arena symbols"
```

### 4. Update CI Workflow

**File**: `.github/workflows/contract-ci.yml`

```yaml
name: Contract CI

on: [push, pull_request]

jobs:
  build-contracts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Rust
        uses: actions-rs/toolchain@v1
        with:
          toolchain: stable
          target: wasm32-unknown-unknown

      - name: Build all contracts (workspace)
        run: |
          # Now works! No more per-crate special casing
          cargo build --workspace --release --target wasm32-unknown-unknown

      - name: Verify WASM outputs
        run: |
          ls -lh target/wasm32-unknown-unknown/release/*.wasm
          
          # Record WASM sizes
          echo "arena_wasm_bytes=$(stat -f%z target/wasm32-unknown-unknown/release/arena.wasm)" >> wasm-metrics.txt
          echo "factory_wasm_bytes=$(stat -f%z target/wasm32-unknown-unknown/release/factory.wasm)" >> wasm-metrics.txt

      - name: Run contract tests
        run: cargo test --workspace

      - name: Upload WASM artifacts
        uses: actions/upload-artifact@v3
        with:
          name: contract-wasm
          path: target/wasm32-unknown-unknown/release/*.wasm
```

### 5. Shared Interface Crate (Alternative)

**File**: `contract/arena-interface/Cargo.toml`

```toml
[package]
name = "arena-interface"
version = "0.1.0"
edition = "2021"

[dependencies]
soroban-sdk = "21.0.0"

[lib]
crate-type = ["cdylib", "rlib"]
```

**File**: `contract/arena-interface/src/lib.rs`

```rust
//! Shared interface for Arena contract.
//! Contains only #[contractclient] trait, no implementation.
//! Both arena and factory can depend on this without symbol conflicts.

use soroban_sdk::{contractclient, Address, Env};

#[contractclient(name = "ArenaClient")]
pub trait ArenaInterface {
    fn initialize(env: Env, admin: Address, entry_fee: i128, max_players: u32);
    fn start_round(env: Env, signature: Signature);
    fn join(env: Env, player: Address, amount: i128);
    // ... other methods
}
```

Then both arena and factory depend on `arena-interface`:

```toml
# arena/Cargo.toml
[dependencies]
arena-interface = { path = "../arena-interface" }

# factory/Cargo.toml
[dependencies]
arena-interface = { path = "../arena-interface" }
```

### 6. Update Integration Tests

**File**: `contract/tests/integration/factory_deploy.rs`

```rust
#[test]
fn factory_deploys_real_arena_wasm() {
    let env = Env::default();
    
    // Deploy factory
    let factory_id = env.register_contract_wasm(None, include_bytes!(
        "../../target/wasm32-unknown-unknown/release/factory.wasm"
    ));
    let factory = FactoryClient::new(&env, &factory_id);

    // Create arena through factory
    let admin = Address::generate(&env);
    let arena_address = factory.create_arena(&admin, &100_0000000, &10);

    // Verify deployed contract is real arena
    let arena = ArenaClient::new(&env, &arena_address);
    let state = arena.get_state();
    assert_eq!(state.admin, admin);
    assert_eq!(state.entry_fee, 100_0000000);
}
```

## Verification

```bash
# 1. Workspace build succeeds
cargo build --workspace --target wasm32-unknown-unknown --release
# Should complete without symbol conflicts

# 2. Factory WASM size decreases
ls -lh target/wasm32-unknown-unknown/release/factory.wasm
# Compare before/after, should be smaller

# 3. No arena symbols in factory
wasm-objdump -x target/wasm32-unknown-unknown/release/factory.wasm | grep unpause
# Should return empty (no matches)

# 4. Integration tests pass
cargo test --package integration-tests
# Should deploy real arena WASM and interact successfully
```

## Acceptance Criteria

- [ ] Factory no longer depends on arena crate implementation
- [ ] Uses contractimport! or shared interface crate
- [ ] Workspace WASM build passes
- [ ] CI removed per-crate special casing
- [ ] Factory WASM size decreased
- [ ] Integration tests deploy real arena WASM
- [ ] Same audit for arena→rwa-adapter
- [ ] ABI snapshot regenerated
- [ ] All tests pass

## Build Order

```
1. arena-interface (if using shared crate approach)
2. arena (generates WASM)
3. factory (imports arena WASM)
4. rwa-adapter (imports arena WASM)
```

## Benefits

- Workspace builds work (no symbol conflicts)
- Factory WASM doesn't include arena code
- Clear dependency boundaries
- Single CI workflow for all contracts
- Smaller factory WASM
- Better separation of concerns

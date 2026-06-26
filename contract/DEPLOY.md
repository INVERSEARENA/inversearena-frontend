# Soroban contract deployment guide

Step-by-step instructions to **build**, **deploy**, and **wire** the Inverse Arena Soroban workspace (`factory`, `arena`, `payout`, `staking`) on **Stellar testnet** and **mainnet**.

> **Note:** Contract logic in this repo may still be minimal (stubs). As constructors and admin entrypoints are added, extend the **Initialization** section with real `contract invoke` examples and keep this file updated.

---

## Prerequisites

| Requirement | Purpose |
|---------------|---------|
| **Rust** | Recent **stable** toolchain (Soroban SDK 22 targets modern Rust; this workspace uses **edition 2024** — use a current `rustup` stable that supports it, or follow `rustc` errors to upgrade). |
| **Wasm target** | `rustup target add wasm32-unknown-unknown` (CLI may add `wasm32v1-none` automatically — use what `stellar contract build` expects). |
| **Stellar CLI** (`stellar`) | Build, deploy, and invoke contracts. [Install Stellar CLI](https://developers.stellar.org/docs/tools/cli/stellar-cli) (`stellar --version` to verify). |
| **jq** (optional) | Parsing JSON in shell examples. |
| **A funded Stellar account** | Deployer identity on the target network (testnet faucet below; mainnet funded from exchange or custodian). |

Confirm CLI:

```bash
stellar --version
rustc --version
```

### Testnet deployment checklist

Before you deploy to testnet, confirm the following:

1. `main` is up to date with `upstream/main`.
2. Your working branch is created from that synced `main`.
3. The deployer account is funded on the target network.
4. You have the contract IDs and init arguments for each contract you plan to invoke.
5. You have the frontend env values ready for the new deployment.

### Account setup

Use a dedicated deployer identity for each network:

```bash
stellar keys generate deployer-testnet
stellar keys address deployer-testnet
stellar keys generate deployer-mainnet
stellar keys address deployer-mainnet
```

Keep the testnet and mainnet identities separate. Do not reuse a mainnet deployer key on testnet or vice versa.

---

## Repository layout

Workspace members (each produces its own WASM):

| Crate | Package name | Typical WASM artifact |
|-------|----------------|-------------------------|
| `contract/factory` | `factory` | `factory.wasm` |
| `contract/arena` | `arena` | `arena.wasm` |
| `contract/payout` | `payout` | `payout.wasm` |
| `contract/staking` | `staking` | `staking.wasm` |

Build output paths are printed by the CLI; they are usually under `target/` with a `wasm32*` release directory.

---

## 1. Build

From the **workspace root** `contract/`:

```bash
cd contract
```

### Option A — Stellar CLI (recommended)

```bash
stellar contract build
```

This builds all workspace contracts. To build one package:

```bash
stellar contract build --package factory
```

### Option B — Cargo only

```bash
cargo build --target wasm32-unknown-unknown --release -p factory
```

Repeat with `-p arena`, `-p payout`, `-p staking` as needed.

Locate the `.wasm` files (CLI output shows paths). Common patterns:

- `target/wasm32-unknown-unknown/release/*.wasm`
- or `target/wasm32v1-none/release/*.wasm` (depending on toolchain / CLI version)

---

## 2. Network identities & funding

### Create a deployer key (once per machine)

```bash
stellar keys generate deployer
stellar keys address deployer
```

### Testnet — fund the account

Use any of:

- **Stellar Laboratory** — [Create account / Friendbot](https://lab.stellar.org/) (select **Testnet**), paste your public key, request XLM.
- **Horizon Friendbot** (example; check [current testnet docs](https://developers.stellar.org/docs/build/guides/friendbot) for the exact URL):

```bash
curl "https://friendbot.stellar.org/?addr=<YOUR_PUBLIC_G_ADDRESS>"
```

You need enough XLM to pay transaction fees and Soroban rent/deposit for deploy + invoke.

### Mainnet — fund the account

Use your organization’s process (exchange withdrawal, custody, treasury). **Never commit secret keys.** Use hardware wallets or multisig for production deployers.

---

## 3. Deploy (testnet)

Set the network to **testnet** (CLI profiles vary by version; use one of the patterns below).

**Passphrase (testnet):**

```text
Test SDF Network ; September 2015
```

**Public RPC / Horizon (testnet defaults):**

| Service | URL |
|---------|-----|
| Soroban RPC | `https://soroban-testnet.stellar.org` |
| Horizon | `https://horizon-testnet.stellar.org` |

Deploy a single WASM (replace WASM path with the file from your build):

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/factory.wasm \
  --source deployer \
  --network testnet
```

The command prints the **contract ID** (starts with `C` on Soroban). Save it.

Repeat for `arena`, `payout`, and `staking` with the correct WASM paths.

> If your CLI uses **upload + deploy** in two steps, follow [Stellar’s upload & deploy cookbook](https://developers.stellar.org/docs/tools/cli/cookbook/upload-deploy): upload WASM, then deploy the contract instance from the uploaded hash.

### Contract initialization sequence

After deployment, initialize the contracts in dependency order:

1. Deploy the shared contracts first if they are referenced by address elsewhere.
2. Initialize the arena contract with the admin, stake token, yield vault, fee, and oracle addresses.
3. Initialize payout and staking contracts with the arena or factory addresses they depend on.
4. Verify each contract can be read back with `stellar contract inspect` or a read-only invoke.
5. Only after the on-chain addresses are confirmed, publish the values to the frontend environment.

---

## 4. Initialization (invoke)

After deployment, call any **constructor** or **admin init** functions your contracts expose. The current stubs may only expose a trivial `hello`; when real init methods exist, examples will look like:

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source deployer \
  --network testnet \
  -- \
  init \
  --admin <G_ADDRESS>
```

Replace `init`, argument names, and types with your contract’s actual interface. Use `stellar contract inspect --wasm <file.wasm>` or published ABI to list callable functions.

**Deployment order (typical for a factory pattern):**

1. Deploy **factory** (and any shared libraries if split).
2. Deploy **arena** / **payout** / **staking** as designed (some may be created by the factory — follow product spec).
3. Run init calls per contract.
4. Register addresses in the frontend env (next section).

### Factory-created arenas

`factory.create_pool(...)` now performs the arena bootstrap needed for a usable pool in one transaction:

1. deploy the arena contract
2. call `init(round_speed)`
3. call `initialize(factory_address)`
4. call `set_token(currency)`
5. transfer arena admin to the caller with `set_admin(caller)`

That means a newly created arena is immediately joinable; no manual post-creation `set_token()` call is required anymore.

---

## 5. Deploy (mainnet)

**Passphrase (mainnet):**

```text
Public Global Stellar Network ; September 2015
```

**Public endpoints (examples — verify current docs):**

| Service | URL |
|---------|-----|
| Soroban RPC | `https://soroban-mainnet.stellar.org` |
| Horizon | `https://horizon.stellar.org` |

Use a **dedicated mainnet deployer** with minimal balance, multisig where possible, and audited WASM.

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/factory.wasm \
  --source mainnet-deployer \
  --network mainnet
```

### Mainnet upgrade / migration (high level)

When you ship a new WASM:

1. **Build** and **test** on testnet first.
2. **Upload** the new WASM (or use the CLI’s upgrade flow if your contract implements [SAC / upgradeable](https://developers.stellar.org/docs/build/smart-contracts) patterns).
3. **Invoke** the contract’s upgrade path (e.g. `upgrade` or `migrate`) if applicable — *only if your Rust code implements this*.
4. **Verify** on Horizon / Soroban RPC (read-only simulations).
5. **Update** frontend and backend env vars; coordinate release windows.

Exact upgrade commands depend on your contract ABI; document them here when implemented.

---

## 6. Environment variables (frontend)

The Next.js app reads public env vars (see `frontend/src/components/hook-d/arenaConstants.ts`). Set these in `.env.local` (never commit secrets):

### Testnet example

```env
NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
NEXT_PUBLIC_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
NEXT_PUBLIC_HORIZON_URL=https://horizon-testnet.stellar.org

NEXT_PUBLIC_FACTORY_CONTRACT_ID=C...
NEXT_PUBLIC_STAKING_CONTRACT_ID=C...
NEXT_PUBLIC_USDC_CONTRACT_ID=C...
```

Optional overrides if defaults change:

- `NEXT_PUBLIC_STAKING_CONTRACT_ID` — staking contract (required for stake flows when not placeholder).

### Mainnet example

```env
NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015
NEXT_PUBLIC_SOROBAN_RPC_URL=https://soroban-mainnet.stellar.org
NEXT_PUBLIC_HORIZON_URL=https://horizon.stellar.org

NEXT_PUBLIC_FACTORY_CONTRACT_ID=C...
NEXT_PUBLIC_STAKING_CONTRACT_ID=C...
NEXT_PUBLIC_USDC_CONTRACT_ID=C...
```

**XLM SAC** on testnet is often fixed in code (`CAS3J7GYLGXMF6TDJBXBGMELNUPVCGXIZ68TZE6GTVASJ63Y32KXVY77` in `arenaConstants.ts`); confirm mainnet USDC/XLM asset contract IDs from [Stellar asset docs](https://developers.stellar.org/docs/build/guides/tokens) before production.

---

## 7. Quick reference — workspace packages

```bash
cd contract
stellar contract build --package factory
stellar contract build --package arena
stellar contract build --package payout
stellar contract build --package staking
```

---

## 8. Troubleshooting

| Issue | What to check |
|--------|----------------|
| `wasm32` target missing | `rustup target list --installed` and add the target the CLI requests. |
| CLI not found | Install Stellar CLI; ensure it is on `PATH`. |
| Insufficient balance | Fund deployer on testnet via Friendbot; mainnet via treasury. |
| Wrong network | Passphrase and RPC URLs must match (testnet vs mainnet). |
| `edition 2024` / Rust version errors | Upgrade Rust stable or align with Soroban SDK release notes. |

---

## 9. Further reading

- [Stellar smart contracts overview](https://developers.stellar.org/docs/build/smart-contracts)
- [Soroban Rust SDK](https://docs.rs/soroban-sdk)
- Error code registry for this repo: `contract/ERRORS.md`

---

## 10. Acceptance checklist (for operators)

- [ ] Rust + Stellar CLI installed and `stellar contract build` succeeds in `contract/`.
- [ ] Testnet deployer funded; all required WASM deployed; contract IDs recorded.
- [ ] Initialization invocations completed (when contract exposes them).
- [ ] `.env.local` updated with IDs and correct network URLs/passphrase.
- [ ] Mainnet: separate process, audited WASM, multisig / key policy followed.

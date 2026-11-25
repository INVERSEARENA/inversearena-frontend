# inverse-ops

Operator CLI for the Inverse Arena contracts (#1648). Use it to inspect an
arena during an incident, decode its events, and run lifecycle operations
without remembering contract ids, argument encodings or function names.

- **Manifest-driven.** Network, RPC URL and contract ids come from
  `contract/deployment-manifest.json`.
- **Spec-driven.** Arguments are encoded, results decoded and contract errors
  named from each contract's own spec, read from its WASM. Nothing is
  hand-maintained, so the CLI cannot drift from the contracts.
- **Safe by default.** State-changing commands are simulated unless you pass
  `--submit`. Mainnet submits need an explicit confirmation. Secrets are never
  taken on the command line or printed.

## Install

```bash
cd tools/ops-cli
npm ci && npm run build
npm link                       # optional: puts `inverse-ops` on your PATH
# or run without building:  npx tsx src/cli.ts <command>
```

Requires Node 20+.

## Configuration

| Setting | Flag | Environment | Default |
| --- | --- | --- | --- |
| Deployment manifest | `--manifest <path>` | `INVERSE_OPS_MANIFEST` | `contract/deployment-manifest.json` in the nearest ancestor |
| RPC URL | `--rpc-url <url>` | `INVERSE_OPS_RPC_URL` | the manifest's `rpcUrl` |
| Contract ids | `--factory`, `--oracle`, `--vault`, `--staking`, `--payout` | | the manifest's `contracts` (`vault` reads `rwa_adapter`) |
| Contract specs | `--wasm-dir <dir>` | | fetched from the network |

An arena is given either by contract id (`C...`) or by factory pool id (`7`).

## Commands

Add `--json` to any command for a machine-readable document on stdout.
Progress and warnings go to stderr.

### `arena show <arena>`

Version, player count, start deadline, fee, oracle and freshness policy,
total yield, leaderboard, players and every round result. A read that fails
(for example on an older arena that lacks a method) is reported in place, not
fatal.

```console
$ inverse-ops arena show 7
arena: CDV4AMW57HA2CJ6IFHDSMY4AMS6EWBTTZTVMA7FPILSGGPF26OSG2ZKF
network: testnet
version: 4
player_count: 12
oracle_freshness_policy:
  max_age_secs: 3600
  warn_age_secs: 1800
…
```

### `arena events <arena> [--round N] [--lookback L | --start-ledger S]`

Arena events decoded into named fields, using the schema in
`contract/arena/src/events.rs`. `--round` keeps the events for one round
(started, commits, reveals, resolution, eliminations). The search covers the
last `--lookback` ledgers (default 17280, about a day), clamped to what the
RPC node retains.

```console
$ inverse-ops --json arena events 7 --round 2 | jq '.events[] | {event, fields}'
{ "event": "round_resolved", "fields": { "schema_version": 1, "round": 2, "eliminated": 5, "survivors": 3 } }
```

### `arena resolve <arena>`

`resolve_round`. Without `--submit`, reports the simulated result, the
minimum resource fee, CPU/IO usage and who must authorize. A contract error is
named:

```console
$ inverse-ops arena resolve 7
inverse-ops: resolve_round failed in simulation: contract error GracePeriodNotElapsed (#12)

$ inverse-ops --signer ledger --submit arena resolve 7
```

### `factory pools [--host G...]`

Arenas created by the factory, or only one host's.

### `vault reserves [--arena <id>...] [--reconcile]`

The RWA adapter's total deposits, per-arena balances, and with `--reconcile`
the difference between the total and the sum over every factory arena
(`unaccounted`). It should be `0`.

### `oracle schedule`

Current rate, last reading, pending scheduled change, activation delay and
rate limits.

### `invoke <contract> <method> [args...]`

Any method, with positional arguments encoded from the spec. `<contract>` is a
kind (`factory`, `oracle`, `vault`, `staking`, `payout`), `arena:<id>`, or a
raw `C...` id. Arguments are given as text:

| Spec type | Write it as |
| --- | --- |
| integers (`u32` … `i128`) | `10000000`, or `10_000_000` |
| `Address` | `G...` or `C...` |
| `bool` | `true` / `false` |
| `BytesN<32>` | hex, with or without `0x` |
| enum / unit union (`Choice`) | the case name: `Heads` |
| `Option<T>` | a value or `none` |
| structs, vecs, maps | JSON |

Put `--` before arguments that start with `-` (negative numbers):
`inverse-ops invoke factory get_arenas -- 0 50`.

```console
$ inverse-ops invoke oracle set_yield_bps 650                      # dry run
$ inverse-ops --signer env:OPS_SECRET --submit invoke oracle set_yield_bps 650
```

## Signing

Mutations are simulated unless `--submit` is given. Submitting needs a signer:

| `--signer` | Source |
| --- | --- |
| `env:VAR` | secret seed in environment variable `VAR` |
| `file:PATH` | secret seed in a file that only its owner can read (`chmod 600`) |
| `ledger[:N]` | Ledger device, account `44'/148'/N'`. Confirm on the device. Needs `npm install @ledgerhq/hw-transport-node-hid @ledgerhq/hw-app-str` |

A secret seed passed directly as `--signer S...` is refused, because it would
end up in shell history and the process list. Signer errors never include the
value.

### Mainnet

`--submit` on a mainnet manifest asks you to type `mainnet` first. In
non-interactive runs, such as CI or scripts, pass `--confirm-mainnet`.
Otherwise nothing is sent.

## Development

```bash
npm test             # unit tests: argument encoding, manifest, signers, safety, events, dry-run/submit flow
npm run typecheck
```

### Smoke test against a local network

```bash
stellar container start local                       # needs Docker
(cd ../../contract && cargo build --workspace --target wasm32v1-none --release)
scripts/local-stack.sh                              # deploys and writes .local/manifest.json
npm run test:smoke                                  # read-only and dry-run checks
OPS_ADMIN_SECRET=$(stellar keys secret inverse-ops-admin) \
  INVERSE_OPS_SMOKE_SIGNER=env:OPS_ADMIN_SECRET npm run test:smoke   # plus a real submit
```

`make dev` (`scripts/dev-stack.sh`, #1647) writes
`contract/deployment-manifest.json` for its local network, which `inverse-ops`
reads by default. The smoke test uses `local-stack.sh` instead because it
needs real deployed contracts and a pool created through the factory, which
it writes to a separate manifest so your dev manifest stays untouched.

`local-stack.sh` creates an arena through `factory.create_pool` but does not
join a player. On a real network, `join_arena` currently fails with
`VaultDepositFailed` (#35): the RWA adapter's nested token transfer needs an
authorization that the arena does not grant. Unit tests miss this because they
mock all auths.

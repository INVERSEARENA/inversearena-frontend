# Contract Workspace

## ABI Snapshots

ABI snapshots live at:

- `arena/abi_snapshot.json`
- `factory/abi_snapshot.json`
- `payout/abi_snapshot.json`
- `staking/abi_snapshot.json`

To update snapshots after an intentional contract API change:

```bash
cd contract
./scripts/generate_abi_snapshots.sh
```

CI runs the same script with `--check` after building the WASM artifacts. If any snapshot differs from the committed version, the check fails and the ABI change must be reviewed and committed intentionally.

The script uses `stellar contract inspect --wasm ... --output xdr-base64-array` when `stellar` is installed, or falls back to `soroban contract inspect`.

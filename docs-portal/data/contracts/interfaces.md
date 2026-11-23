# interfaces contract API

Source: `contract/interfaces/src`

## `contract/interfaces/src/lib.rs`

### pub trait `ArenaFactoryInterface` — line 48

Cross-contract interface the arena calls back into the factory with.

The factory exposes additional methods not used cross-contract (e.g.
`create_pool`); only the subset called from arena belongs here.

### fn `update_arena_status` — line 50

Notify the factory that an arena's lifecycle state has changed.

### pub trait `YieldVaultInterface` — line 57

Cross-contract interface for the RWA-backed yield vault.

### fn `withdraw` — line 60

Partial withdrawal; returns the amount actually transferred.

### pub trait `YieldOracleInterface` — line 70

Minimal cross-contract interface for the yield-rate oracle.

### pub trait `ArenaInterface` — line 79

Cross-contract interface exposed by an arena instance, used by the factory
for status-polling and administrative operations.

### fn `get_status` — line 81

Returns the arena's current lifecycle status.

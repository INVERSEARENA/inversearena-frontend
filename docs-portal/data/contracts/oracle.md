# oracle contract API

Source: `contract/oracle/src`

## `contract/oracle/src/lib.rs`

### pub fn `set_yield_bps` — line 241

Schedule (or, when `activation_delay == 0`, apply immediately) a new
yield rate. The move is bounded by `max_delta_bps` against the
currently effective rate. A pending update is overwritten by a newer
one (last wins).

### pub fn `set_rate_to_zero` — line 291

Emergency path: set the rate to zero immediately, bypassing the delta
bound and any activation delay, and clearing any pending rate update.
Explicitly evented (`zeroed`) for incident response (#1570).

### pub fn `set_max_delta_bps` — line 310

Admin-configurable per-update bound, itself subject to the activation
delay when one is configured (last wins).

### pub fn `set_activation_delay` — line 346

Admin-configurable activation delay within the hard bound, itself
subject to the current delay when one is configured (last wins).

### pub fn `get_rate_schedule` — line 423

Frontend/keeper read of the full schedule (#1570).

### pub fn `add_reporter` — line 486

Register a rate reporter. Admin-managed, bounded by `MAX_REPORTERS`;
duplicate registration is rejected. Removing a reporter also drops
their outstanding submission, so rotation during an active round can
never leave a ghost vote in the median.

### pub fn `remove_reporter` — line 515

Remove a rate reporter and their outstanding submission. If the
removal drops the fresh count below quorum the effective rate stays
at the last finalized value and `get_oracle_status` reports
`stale == true` until quorum recovers.

### pub fn `set_quorum` — line 558

Fresh reports required before a median is finalized. Valid range is
`1..=MAX_REPORTERS`; setting it above the current reporter count is
allowed (the oracle simply stays stale until enough reporters are
added back), which keeps rotation ordering flexible.

### pub fn `set_max_age_secs` — line 574

Maximum age (seconds) of a submission to count as fresh.

### pub fn `set_max_deviation_bps` — line 590

Outlier band around the median, in bps. Reports whose rate deviates
from the pre-filter median by more than this are excluded from the
finalized value and evented (`out_rej`). `0` disables rejection.

### pub fn `submit_rate` — line 611

Submit a rate as a registered reporter (#1578). The reporter's
signature is required. Submissions are not subject to the admin
`max_delta_bps` bound (reporters are independent sources), but must
still respect the `max_rate` ceiling. When this submission brings the
fresh count to quorum the median is finalized immediately: outliers
are dropped (`out_rej`), the median is persisted as the effective
rate, any pending scheduled admin rate is superseded, and
`median_set` + `rate_obs` are emitted.

### pub fn `get_reporters` — line 652

Registered reporters, in insertion order.

### pub fn `get_oracle_status` — line 663

Reporter-set companion to `get_current_yield_bps` (#1578): the same
effective rate plus quorum/staleness provenance. `stale == true`
means fewer than `quorum` fresh reports exist, so `rate_bps` is the
last finalized value rather than a live median.

### pub fn `get_current_yield_bps` — line 681

Effective rate at the current ledger time: the pending rate once its
`effective_at` has passed, otherwise the stored rate. Read-only; due
updates are persisted lazily by the next admin write.

### pub fn `get_oracle_reading` — line 690

Rate plus observation provenance (#1512): additive alongside
`get_current_yield_bps`, which keeps returning just the bare rate.
`observed_at == 0` means no rate has ever been applied on this
instance — callers must treat that as maximally stale, not as a
real timestamp.

# Host whitelist applications

Authenticated wallets can submit one open application at a time with contact
information and an explanation of their intended use. Admins can list pending
applications, reject them, or approve them. Approval creates an unsigned
Soroban transaction for `add_to_whitelist`; the application remains `APPROVED`
until a reconciler observes the successful on-chain transaction and calls the
confirmation transition, which changes it to `CONFIRMED`.

The audit middleware records all admin review transitions. The application
table is intentionally append-only from the API perspective: a rejected
wallet must submit a new application rather than mutating the old decision.

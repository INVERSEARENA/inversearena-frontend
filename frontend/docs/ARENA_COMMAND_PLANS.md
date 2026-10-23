# Arena command plans

Arena transaction flows describe the intended operation as a plain
`ArenaCommandPlan` before handing it to the Stellar SDK composer. The plan
records the actor, target contract, expected preconditions, intended call,
amounts, capability-store revision, and an expiry. The composer adapter is the
boundary that turns a plan into an SDK operation and transaction envelope.

Preconditions in a plan are declarative, not proof that the chain still
satisfies them. Read surfaces may reuse a verified eligibility snapshot, but
mutation flows must perform a fresh check immediately before transaction
construction; Soroban contract authorization/state checks remain authoritative
at submission.

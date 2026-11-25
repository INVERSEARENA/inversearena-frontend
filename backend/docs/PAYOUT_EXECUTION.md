# Payout execution boundaries

`PayoutOrchestrator` coordinates transaction idempotency, record state, retries, and confirmation. It depends on three contracts:

- `PayoutBuilder` prepares the unsigned Stellar transaction and validates the fee ceiling.
- `Signer` signs unsigned XDR and may return `null` when a signature is not available. The existing local secret signer is isolated in `payoutExecution.ts`; an external signer can implement the same interface.
- `Submitter` submits signed transactions to Soroban.

The worker receives the orchestrator and continues to process queued submissions and confirmations. Externally signed XDR still passes the existing payout destination, arena, amount, contract, and method checks before it can be queued. Batch and retry behavior remain owned by the transaction repository and worker state machine.

CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY,
  -- Unique: one on-chain payout per payout id (#1353). Idempotency keys are
  -- caller-supplied, so keying de-duplication on them alone let a retry with a
  -- fresh key create a second real payout for the same prize.
  payout_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  source_account TEXT NOT NULL,
  destination_account TEXT NOT NULL,
  owner_id TEXT,
  asset TEXT NOT NULL,
  amount_stroops TEXT NOT NULL,
  nonce BIGINT NOT NULL,
  status TEXT NOT NULL,
  unsigned_xdr TEXT NOT NULL,
  signed_xdr TEXT,
  tx_hash TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ,
  CONSTRAINT chk_transactions_status CHECK (
    status IN ('built', 'queued', 'awaiting_signature', 'submitted', 'confirmed', 'failed', 'dead')
  ),
  CONSTRAINT chk_transactions_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT uq_transactions_source_nonce UNIQUE (source_account, nonce)
);

CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions (status);
CREATE INDEX IF NOT EXISTS idx_transactions_tx_hash ON transactions (tx_hash);
CREATE INDEX IF NOT EXISTS idx_transactions_source_nonce ON transactions (source_account, nonce DESC);

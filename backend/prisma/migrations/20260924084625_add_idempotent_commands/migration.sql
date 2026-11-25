-- CreateTable
CREATE TABLE "idempotent_commands" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotent_commands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "idempotent_commands_idempotency_key_key" ON "idempotent_commands"("idempotency_key");

-- CreateIndex
CREATE INDEX "idempotent_commands_round_id_idx" ON "idempotent_commands"("round_id");

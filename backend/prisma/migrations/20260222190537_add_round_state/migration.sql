-- AlterTable
ALTER TABLE "rounds" ADD COLUMN "state" TEXT NOT NULL DEFAULT 'OPEN';
ALTER TABLE "rounds" ADD COLUMN "metadata" JSONB;

-- CreateIndex
CREATE INDEX "rounds_state_idx" ON "rounds"("state");

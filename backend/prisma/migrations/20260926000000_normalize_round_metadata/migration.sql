-- AlterTable
ALTER TABLE "rounds" ADD COLUMN "oracle_yield" DOUBLE PRECISION,
ADD COLUMN "random_seed" TEXT,
ADD COLUMN "player_choices" JSONB,
ADD COLUMN "all_active_player_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "resolution" JSONB;

-- CreateTable
CREATE TABLE "backfill_cursors" (
    "id" TEXT NOT NULL,
    "last_processed" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "backfill_cursors_pkey" PRIMARY KEY ("id")
);

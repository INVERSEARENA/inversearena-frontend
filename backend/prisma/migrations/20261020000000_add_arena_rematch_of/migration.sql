-- Rematch pools (#1572).
--
-- A rematch arena records the arena it was created from, so the result page
-- can offer follow-up rematches, the backend can send prior participants a
-- single in-app/push notification, and repeated submissions of the same
-- linkage can be de-duplicated. Null means "original arena".

ALTER TABLE "arenas" ADD COLUMN "rematch_of" TEXT;

CREATE INDEX "arenas_rematch_of_idx" ON "arenas"("rematch_of");

ALTER TABLE "arenas" ADD CONSTRAINT "arenas_rematch_of_fkey"
  FOREIGN KEY ("rematch_of") REFERENCES "arenas"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

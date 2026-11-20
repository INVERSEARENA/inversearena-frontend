-- Progressive jackpot funded by platform fees (#1719)
CREATE TABLE "jackpots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stake_token" TEXT NOT NULL UNIQUE,
    "balance_atomic" BIGINT NOT NULL DEFAULT 0,
    "share_bps" INTEGER NOT NULL DEFAULT 500,
    "award_rule" TEXT NOT NULL DEFAULT 'PERFECT_STREAK',
    "award_threshold" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "jackpots_created_at_idx" ON "jackpots"("created_at" DESC);

-- Jackpot award records (#1719)
CREATE TABLE "jackpot_awards" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jackpot_id" TEXT NOT NULL,
    "arena_id" TEXT NOT NULL,
    "winner_id" TEXT NOT NULL,
    "amount_atomic" BIGINT NOT NULL,
    "award_reason" TEXT NOT NULL,
    "tx_hash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "jackpot_awards_jackpot_id_fkey" FOREIGN KEY ("jackpot_id") REFERENCES "jackpots" ("id") ON DELETE CASCADE
);

CREATE INDEX "jackpot_awards_jackpot_id_idx" ON "jackpot_awards"("jackpot_id");
CREATE INDEX "jackpot_awards_arena_id_idx" ON "jackpot_awards"("arena_id");
CREATE INDEX "jackpot_awards_winner_id_idx" ON "jackpot_awards"("winner_id");
CREATE INDEX "jackpot_awards_status_idx" ON "jackpot_awards"("status");

-- In-lobby chat and reactions (#1724)
CREATE TABLE "arena_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "arena_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "message_type" TEXT NOT NULL DEFAULT 'chat',
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "report_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "arena_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE
);

CREATE INDEX "arena_messages_arena_id_created_at_idx" ON "arena_messages"("arena_id", "created_at" DESC);
CREATE INDEX "arena_messages_user_id_idx" ON "arena_messages"("user_id");
CREATE INDEX "arena_messages_status_idx" ON "arena_messages"("status");

-- Message reports (#1724)
CREATE TABLE "message_reports" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "message_id" TEXT NOT NULL,
    "reporter_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "message_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users" ("id") ON DELETE CASCADE
);

CREATE INDEX "message_reports_message_id_idx" ON "message_reports"("message_id");
CREATE INDEX "message_reports_reporter_id_idx" ON "message_reports"("reporter_id");
CREATE INDEX "message_reports_status_created_at_idx" ON "message_reports"("status", "created_at" DESC);

-- Follow relationships (#1723)
CREATE TABLE "follows" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "follower_id" TEXT NOT NULL,
    "following_id" TEXT NOT NULL,
    "is_followable" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "follows_follower_id_fkey" FOREIGN KEY ("follower_id") REFERENCES "users" ("id") ON DELETE CASCADE,
    CONSTRAINT "follows_following_id_fkey" FOREIGN KEY ("following_id") REFERENCES "users" ("id") ON DELETE CASCADE,
    CONSTRAINT "follows_follower_id_following_id_key" UNIQUE("follower_id", "following_id")
);

CREATE INDEX "follows_follower_id_idx" ON "follows"("follower_id");
CREATE INDEX "follows_following_id_idx" ON "follows"("following_id");
CREATE INDEX "follows_follower_id_created_at_idx" ON "follows"("follower_id", "created_at" DESC);

-- Clans (#1725)
CREATE TABLE "clans" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL UNIQUE,
    "tag" VARCHAR(5) NOT NULL UNIQUE,
    "owner_address" TEXT NOT NULL,
    "member_count" INTEGER NOT NULL DEFAULT 1,
    "total_wins" INTEGER NOT NULL DEFAULT 0,
    "total_staked" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avg_win_rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "join_policy" TEXT NOT NULL DEFAULT 'open',
    "description" TEXT,
    "image_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "clans_created_at_idx" ON "clans"("created_at" DESC);
CREATE INDEX "clans_total_wins_idx" ON "clans"("total_wins" DESC);

-- Clan members (#1725)
CREATE TABLE "clan_members" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clan_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL UNIQUE,
    "role" TEXT NOT NULL DEFAULT 'member',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "clan_members_clan_id_fkey" FOREIGN KEY ("clan_id") REFERENCES "clans" ("id") ON DELETE CASCADE,
    CONSTRAINT "clan_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE
);

CREATE INDEX "clan_members_clan_id_idx" ON "clan_members"("clan_id");
CREATE INDEX "clan_members_role_idx" ON "clan_members"("role");

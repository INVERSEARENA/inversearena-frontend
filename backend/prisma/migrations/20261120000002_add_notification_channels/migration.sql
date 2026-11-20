-- Discord/Telegram notification channels, granular preferences and retry state (#1735).

-- Extend existing notification tables without changing their meaning.
ALTER TABLE "notification_preferences"
    ADD COLUMN "telegram_enabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "discord_enabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "arena_announcement_notifications" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "notification_deliveries"
    ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "next_attempt_at" TIMESTAMP(3),
    ADD COLUMN "dead_lettered_at" TIMESTAMP(3),
    ADD COLUMN "last_error" TEXT,
    ADD COLUMN "context" JSONB;

-- CreateTable
CREATE TABLE "notification_channel_preferences" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_channel_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_channel_links" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "display_name" TEXT,
    "metadata" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_channel_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_link_codes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_link_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "arena_notification_webhooks" (
    "id" TEXT NOT NULL,
    "arena_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "name" TEXT,
    "created_by" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "arena_notification_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_channel_preferences_user_id_event_type_channel_key" ON "notification_channel_preferences"("user_id", "event_type", "channel");

-- CreateIndex
CREATE INDEX "notification_channel_preferences_user_id_idx" ON "notification_channel_preferences"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_channel_links_user_id_channel_key" ON "notification_channel_links"("user_id", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "notification_channel_links_channel_external_id_key" ON "notification_channel_links"("channel", "external_id");

-- CreateIndex
CREATE INDEX "notification_channel_links_user_id_idx" ON "notification_channel_links"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_link_codes_code_hash_key" ON "notification_link_codes"("code_hash");

-- CreateIndex
CREATE INDEX "notification_link_codes_user_id_idx" ON "notification_link_codes"("user_id");

-- CreateIndex
CREATE INDEX "arena_notification_webhooks_arena_id_idx" ON "arena_notification_webhooks"("arena_id");

-- CreateIndex
CREATE INDEX "notification_deliveries_status_next_attempt_at_idx" ON "notification_deliveries"("status", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "notification_channel_preferences" ADD CONSTRAINT "notification_channel_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_channel_links" ADD CONSTRAINT "notification_channel_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_link_codes" ADD CONSTRAINT "notification_link_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "arena_notification_webhooks" ADD CONSTRAINT "arena_notification_webhooks_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "arena_notification_webhooks" ADD CONSTRAINT "arena_notification_webhooks_arena_id_fkey" FOREIGN KEY ("arena_id") REFERENCES "arenas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

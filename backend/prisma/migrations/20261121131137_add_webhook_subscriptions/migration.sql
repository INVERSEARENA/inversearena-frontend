-- CreateTable WebhookSubscription
CREATE TABLE "webhook_subscriptions" (
  "id" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "secret" TEXT NOT NULL,
  "event_filters" TEXT[] DEFAULT ARRAY['*'],
  "status" TEXT NOT NULL DEFAULT 'active',
  "failure_count" INTEGER NOT NULL DEFAULT 0,
  "last_failed_at" TIMESTAMP(3),
  "last_success_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable WebhookDeliveryLog
CREATE TABLE "webhook_delivery_logs" (
  "id" TEXT NOT NULL,
  "subscription_id" TEXT NOT NULL,
  "outbox_event_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "http_status" INTEGER,
  "response_time" INTEGER,
  "error" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "webhook_delivery_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_subscriptions_status_created_at_idx" ON "webhook_subscriptions"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "webhook_subscriptions_status_idx" ON "webhook_subscriptions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_delivery_logs_subscription_id_idempotency_key_key" ON "webhook_delivery_logs"("subscription_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "webhook_delivery_logs_subscription_id_created_at_idx" ON "webhook_delivery_logs"("subscription_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "webhook_delivery_logs_status_created_at_idx" ON "webhook_delivery_logs"("status", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "webhook_delivery_logs" ADD CONSTRAINT "webhook_delivery_logs_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "webhook_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

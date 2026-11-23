-- CreateTable ReferralCode
CREATE TABLE "referral_codes" (
    "id" TEXT NOT NULL,
    "referrer_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "attribution_window_expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable ReferralReward
CREATE TABLE "referral_rewards" (
    "id" TEXT NOT NULL,
    "referral_code_id" TEXT NOT NULL,
    "referee_id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "arena_count" INTEGER NOT NULL DEFAULT 0,
    "total_stake" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reward_amount" DOUBLE PRECISION,
    "revoke_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "qualified_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),

    CONSTRAINT "referral_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "referral_codes_code_key" ON "referral_codes"("code");

-- CreateIndex
CREATE INDEX "referral_codes_referrer_id_idx" ON "referral_codes"("referrer_id");

-- CreateIndex
CREATE INDEX "referral_codes_code_idx" ON "referral_codes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "referral_rewards_referral_code_id_referee_id_key" ON "referral_rewards"("referral_code_id", "referee_id");

-- CreateIndex
CREATE INDEX "referral_rewards_referee_id_idx" ON "referral_rewards"("referee_id");

-- CreateIndex
CREATE INDEX "referral_rewards_state_created_at_idx" ON "referral_rewards"("state", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_referrer_id_fkey" FOREIGN KEY ("referrer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_referral_code_id_fkey" FOREIGN KEY ("referral_code_id") REFERENCES "referral_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_referee_id_fkey" FOREIGN KEY ("referee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

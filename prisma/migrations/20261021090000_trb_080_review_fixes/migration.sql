-- TRB-080 review fixes (docs/DELIVERY.md). Additive: a confirmed destination
-- refusal is recorded on the delivery that received it, so the blocking decision
-- survives a failure before its effects are applied. Existing rows get nulls.

-- AlterTable
ALTER TABLE "delivery" ADD COLUMN "destination_block_reason" TEXT,
ADD COLUMN "destination_refused_at" TIMESTAMPTZ(3),
ADD COLUMN "destination_block_applied_at" TIMESTAMPTZ(3);

-- The refusal carries its time; only a recorded refusal can be applied.
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_destination_block_fields"
  CHECK (("destination_block_reason" IS NULL) = ("destination_refused_at" IS NULL)
     AND ("destination_block_applied_at" IS NULL OR "destination_block_reason" IS NOT NULL)
     AND ("destination_block_reason" IS NULL
          OR "destination_block_reason" IN ('BOT_BLOCKED', 'USER_DEACTIVATED')));

-- Recorded refusals whose effects are still to be applied (recovery sweep).
CREATE INDEX "delivery_destination_block_pending" ON "delivery" ("destination_refused_at")
  WHERE "destination_block_reason" IS NOT NULL AND "destination_block_applied_at" IS NULL;

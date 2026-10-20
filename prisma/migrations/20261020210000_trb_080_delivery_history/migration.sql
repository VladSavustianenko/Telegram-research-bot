-- TRB-080: reliable delivery and history (docs/DELIVERY.md). Additive: existing
-- deliveries, parts (payloads, states, Telegram message IDs), UNKNOWN/SUPPRESSED
-- evidence, runs, attempts, reservations and ledger entries are not changed.
-- No confirmation is invented for any existing delivery.

-- AlterEnum (new values are not used in this migration)
ALTER TYPE "AuditEventKind" ADD VALUE 'DESTINATION_BLOCKED';
ALTER TYPE "AuditEventKind" ADD VALUE 'DESTINATION_RESTORED';

-- CreateEnum
CREATE TYPE "DeliveryPartKind" AS ENUM ('MESSAGE', 'DOCUMENT');

-- AlterTable: document parts and per-part send evidence.
ALTER TABLE "delivery_part" ADD COLUMN "kind" "DeliveryPartKind" NOT NULL DEFAULT 'MESSAGE',
ADD COLUMN "file_name" TEXT,
ADD COLUMN "file_content" TEXT,
ADD COLUMN "send_started_at" TIMESTAMPTZ(3),
ADD COLUMN "error_code" TEXT;

-- AlterTable: creation order for per-chat ordering (existing rows are numbered in
-- table order; they are finished or waiting, and only their relative order matters).
ALTER TABLE "delivery" ADD COLUMN "seq" BIGSERIAL NOT NULL;

-- AlterTable: confirmed unavailable private chat.
ALTER TABLE "app_user" ADD COLUMN "chat_blocked_at" TIMESTAMPTZ(3),
ADD COLUMN "chat_block_reason" TEXT;

-- CreateTable
CREATE TABLE "delivery_event" (
    "id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),

    CONSTRAINT "delivery_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "delivery_seq_key" ON "delivery"("seq");

-- CreateIndex
CREATE INDEX "delivery_event_delivery_id_idx" ON "delivery_event"("delivery_id");

-- AddForeignKey
ALTER TABLE "delivery_event" ADD CONSTRAINT "delivery_event_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "delivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Constraints Prisma cannot express.

-- At most one undispatched wake-up per delivery; new requests merge into it.
CREATE UNIQUE INDEX "delivery_event_one_pending" ON "delivery_event" ("delivery_id")
  WHERE "dispatched_at" IS NULL AND "cancelled_at" IS NULL;
CREATE INDEX "delivery_event_due" ON "delivery_event" ("available_at")
  WHERE "dispatched_at" IS NULL AND "cancelled_at" IS NULL;
-- Unfinished deliveries per chat, in order (per-chat ordering check).
CREATE INDEX "delivery_chat_unfinished" ON "delivery" ("chat_id", "seq")
  WHERE "state" IN ('PENDING', 'SENDING', 'RETRYABLE_FAILURE');

-- A document part carries its file; a message part does not.
ALTER TABLE "delivery_part" ADD CONSTRAINT "delivery_part_kind_fields"
  CHECK (("kind" = 'DOCUMENT') = ("file_name" IS NOT NULL AND "file_content" IS NOT NULL));

-- Only a confirmed block is recorded, always with its reason.
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_chat_block_reason"
  CHECK (("chat_blocked_at" IS NULL) = ("chat_block_reason" IS NULL));

-- Run delivery suppression gains CHAT_BLOCKED (delivery only, like TASK_DELETED).
ALTER TABLE "research_run" DROP CONSTRAINT "research_run_suppression_reason";
ALTER TABLE "research_run" ADD CONSTRAINT "research_run_suppression_reason"
  CHECK (("delivery_suppressed_at" IS NULL) = ("delivery_suppression_reason" IS NULL)
     AND ("delivery_suppression_reason" IS NULL
          OR "delivery_suppression_reason" IN ('USER_SUSPENDED', 'TASK_DELETED', 'CHAT_BLOCKED')));

-- Stored payloads are immutable: resends copy them, nothing rewrites them.
CREATE FUNCTION "delivery_part_payload_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."delivery_id" IS DISTINCT FROM OLD."delivery_id"
     OR NEW."ordinal" IS DISTINCT FROM OLD."ordinal"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."html" IS DISTINCT FROM OLD."html"
     OR NEW."reply_markup"::text IS DISTINCT FROM OLD."reply_markup"::text
     OR NEW."content_hash" IS DISTINCT FROM OLD."content_hash"
     OR NEW."file_name" IS DISTINCT FROM OLD."file_name"
     OR NEW."file_content" IS DISTINCT FROM OLD."file_content" THEN
    RAISE EXCEPTION 'delivery_part payload is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "delivery_part_payload_immutable"
  BEFORE UPDATE ON "delivery_part"
  FOR EACH ROW EXECUTE FUNCTION "delivery_part_payload_immutable"();

-- Existing deliveries waiting to be sent enter the delivery queue: one wake-up
-- each (a retry keeps its scheduled time). SENDING deliveries of the old worker
-- are recovered by the lease sweep (an in-flight part becomes UNKNOWN). Finished
-- deliveries (SENT, UNKNOWN, PERMANENT_FAILURE, SUPPRESSED) get no event.
INSERT INTO "delivery_event" ("id", "delivery_id", "reason", "available_at")
SELECT gen_random_uuid(), "id", 'MIGRATION_BACKFILL',
       CASE WHEN "state" = 'RETRYABLE_FAILURE' THEN "next_attempt_at" ELSE now() END
  FROM "delivery"
 WHERE "state" IN ('PENDING', 'RETRYABLE_FAILURE') AND "suppressed_at" IS NULL;

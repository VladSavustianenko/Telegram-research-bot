-- TRB-080 follow-up (docs/DELIVERY.md): an explicit marker for updates that passed
-- the ingress transport checks. Only such an update may supersede a recorded
-- destination refusal. Existing rows are not marked: no historical recovery
-- evidence is invented (they predate every recorded refusal anyway).

-- AlterTable
ALTER TABLE "telegram_update" ADD COLUMN "private_chat_verified" BOOLEAN NOT NULL DEFAULT false;

-- Verified updates per sender, by time (supersession check).
CREATE INDEX "telegram_update_verified_sender" ON "telegram_update" ("sender_telegram_id", "received_at")
  WHERE "private_chat_verified";

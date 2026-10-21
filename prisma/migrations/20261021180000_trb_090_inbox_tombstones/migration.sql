-- TRB-090 review fix (docs/RETENTION.md): inbox records are never deleted by
-- retention; after the metadata period they are reduced to a deduplication
-- tombstone, so a replayed update of any kind can never execute again.
-- Additive: existing rows are unchanged (all stay complete until redacted).

-- AlterTable
ALTER TABLE "telegram_update" ADD COLUMN "metadata_redacted_at" TIMESTAMPTZ(3);

-- A tombstone holds no sender, chat, reason, run link or restoration evidence.
ALTER TABLE "telegram_update" ADD CONSTRAINT "telegram_update_tombstone_minimal"
  CHECK ("metadata_redacted_at" IS NULL
      OR ("sender_telegram_id" IS NULL AND "chat_type" IS NULL AND "reason" IS NULL
          AND "run_id" IS NULL AND NOT "private_chat_verified"));

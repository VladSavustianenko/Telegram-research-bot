-- TRB-090: administration (per-user limit overrides, invitation revocation,
-- accounting corrections) and data lifecycle (retention markers).
-- docs/ADMINISTRATION.md, docs/RETENTION.md. Additive: no existing row is
-- changed, no content is removed by this migration, no evidence is invented.

-- AlterEnum (new values are not used in this migration)
ALTER TYPE "AuditEventKind" ADD VALUE 'LIMIT_CHANGED';
ALTER TYPE "AuditEventKind" ADD VALUE 'INVITATION_REVOKED';
ALTER TYPE "LedgerKind" ADD VALUE 'CORRECT';

-- AlterTable: per-user limit overrides (null = environment default).
ALTER TABLE "app_user" ADD COLUMN "limit_saved_tasks" INTEGER,
ADD COLUMN "limit_active_tasks" INTEGER,
ADD COLUMN "limit_daily_runs" INTEGER,
ADD COLUMN "limit_daily_manual_runs" INTEGER,
ADD COLUMN "limit_active_runs" INTEGER,
ADD COLUMN "limit_monthly_budget_micros" BIGINT;

ALTER TABLE "app_user" ADD CONSTRAINT "app_user_limit_overrides"
  CHECK (("limit_saved_tasks" IS NULL OR "limit_saved_tasks" BETWEEN 0 AND 1000)
     AND ("limit_active_tasks" IS NULL OR "limit_active_tasks" BETWEEN 0 AND 1000)
     AND ("limit_daily_runs" IS NULL OR "limit_daily_runs" BETWEEN 0 AND 1000)
     AND ("limit_daily_manual_runs" IS NULL OR "limit_daily_manual_runs" BETWEEN 0 AND 1000)
     AND ("limit_active_runs" IS NULL OR "limit_active_runs" BETWEEN 0 AND 100)
     AND ("limit_monthly_budget_micros" IS NULL OR "limit_monthly_budget_micros" >= 0));

-- AlterTable: invitation revocation.
ALTER TABLE "invitation" ADD COLUMN "revoked_at" TIMESTAMPTZ(3),
ADD COLUMN "revoked_by_user_id" UUID;
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_revoked_or_redeemed"
  CHECK ("revoked_at" IS NULL OR "redeemed_at" IS NULL);
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_revocation_fields"
  CHECK (("revoked_at" IS NULL) = ("revoked_by_user_id" IS NULL));

-- Retention replaces the hash of a finished (redeemed, revoked or expired)
-- invitation with a marker that no token hashes to (docs/RETENTION.md).
ALTER TABLE "invitation" DROP CONSTRAINT "invitation_token_hash_format";
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_token_hash_format"
  CHECK ("token_hash" ~ '^[0-9a-f]{64}$' OR "token_hash" = 'cleared:' || "id"::text);

-- AlterTable: retention markers.
ALTER TABLE "research_run" ADD COLUMN "content_purged_at" TIMESTAMPTZ(3);
ALTER TABLE "delivery_part" ADD COLUMN "content_purged_at" TIMESTAMPTZ(3);
ALTER TABLE "task" ADD COLUMN "content_purged_at" TIMESTAMPTZ(3);

-- A purged task is a deleted one.
ALTER TABLE "task" ADD CONSTRAINT "task_purged_is_deleted"
  CHECK ("content_purged_at" IS NULL OR "state" = 'DELETED');
-- Content is purged only from finished runs.
ALTER TABLE "research_run" ADD CONSTRAINT "research_run_purged_is_terminal"
  CHECK ("content_purged_at" IS NULL OR "state" IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN'));

-- A succeeded run keeps its outcome; its report text is required until it is purged.
ALTER TABLE "research_run" DROP CONSTRAINT "research_run_succeeded_has_report";
ALTER TABLE "research_run" ADD CONSTRAINT "research_run_succeeded_has_report"
  CHECK ("state" <> 'SUCCEEDED'
      OR ("outcome" IS NOT NULL AND ("report_text" IS NOT NULL OR "content_purged_at" IS NOT NULL)));

-- A document part carries its file until its content is purged.
ALTER TABLE "delivery_part" DROP CONSTRAINT "delivery_part_kind_fields";
ALTER TABLE "delivery_part" ADD CONSTRAINT "delivery_part_kind_fields"
  CHECK (("kind" = 'DOCUMENT') = ("file_name" IS NOT NULL)
     AND ("kind" <> 'DOCUMENT' OR "file_content" IS NOT NULL OR "content_purged_at" IS NOT NULL)
     AND ("kind" = 'DOCUMENT' OR "file_content" IS NULL));
-- A purged part is empty and was never in flight.
ALTER TABLE "delivery_part" ADD CONSTRAINT "delivery_part_purged_empty"
  CHECK ("content_purged_at" IS NULL
      OR ("html" = '' AND "file_content" IS NULL AND "reply_markup" IS NULL AND "state" <> 'SENDING'));

-- Payloads stay immutable, with exactly one exception: the retention purge,
-- which empties a part once (html '', no buttons, no file text) and sets
-- content_purged_at. Identity, hash, file name and send evidence never change
-- through it, and a purged part can never be filled again.
CREATE OR REPLACE FUNCTION "delivery_part_payload_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."delivery_id" IS DISTINCT FROM OLD."delivery_id"
     OR NEW."ordinal" IS DISTINCT FROM OLD."ordinal"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."content_hash" IS DISTINCT FROM OLD."content_hash"
     OR NEW."file_name" IS DISTINCT FROM OLD."file_name" THEN
    RAISE EXCEPTION 'delivery_part payload is immutable';
  END IF;
  IF OLD."content_purged_at" IS NOT NULL AND NEW."content_purged_at" IS DISTINCT FROM OLD."content_purged_at" THEN
    RAISE EXCEPTION 'delivery_part purge is final';
  END IF;
  IF NEW."html" IS DISTINCT FROM OLD."html"
     OR NEW."reply_markup"::text IS DISTINCT FROM OLD."reply_markup"::text
     OR NEW."file_content" IS DISTINCT FROM OLD."file_content" THEN
    IF NOT (OLD."content_purged_at" IS NULL AND NEW."content_purged_at" IS NOT NULL
            AND NEW."html" = '' AND NEW."reply_markup" IS NULL AND NEW."file_content" IS NULL) THEN
      RAISE EXCEPTION 'delivery_part payload is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Retention candidates.
CREATE INDEX "research_run_content_retention" ON "research_run" ("completed_at")
  WHERE "content_purged_at" IS NULL AND "state" IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN');
CREATE INDEX "delivery_terminal_updated" ON "delivery" ("updated_at")
  WHERE "state" IN ('SENT', 'UNKNOWN', 'PERMANENT_FAILURE', 'SUPPRESSED');
CREATE INDEX "telegram_update_received_at" ON "telegram_update" ("received_at");

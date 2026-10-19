-- AlterTable
ALTER TABLE "delivery" ADD COLUMN     "suppressed_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "research_run" ADD COLUMN     "delivery_suppressed_at" TIMESTAMPTZ(3);

-- Existing rows (TRB-030 review fix).
-- Deliveries already SUPPRESSED keep their state; they get a decision timestamp
-- (their updated_at) so the new check holds.
UPDATE "delivery" SET "suppressed_at" = "updated_at" WHERE "state" = 'SUPPRESSED';

-- Users suspended now: record the decision for their unfinished work, as a
-- suspension does from now on. Earlier suspensions that were already reactivated
-- left no evidence of which work they affected and cannot be reconstructed.
UPDATE "research_run" SET "delivery_suppressed_at" = now()
 WHERE "state" IN ('QUEUED', 'RUNNING')
   AND "user_id" IN (SELECT "id" FROM "app_user" WHERE "status" = 'SUSPENDED');
UPDATE "delivery" SET "suppressed_at" = now()
 WHERE "state" = 'SENDING' AND "suppressed_at" IS NULL
   AND "run_id" IN (SELECT r."id" FROM "research_run" r JOIN "app_user" u ON u."id" = r."user_id"
                     WHERE u."status" = 'SUSPENDED');

-- A suppressed delivery always carries its decision.
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_suppressed_has_decision"
  CHECK ("state" <> 'SUPPRESSED' OR "suppressed_at" IS NOT NULL);

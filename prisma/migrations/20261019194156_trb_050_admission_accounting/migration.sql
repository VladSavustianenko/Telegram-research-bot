-- CreateEnum
CREATE TYPE "RunTrigger" AS ENUM ('MANUAL', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('RESERVED', 'RELEASED', 'SETTLED', 'UNRESOLVED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "LedgerKind" AS ENUM ('RESERVE', 'RELEASE', 'SETTLE', 'UNRESOLVED', 'OVERRUN', 'RESOLVE');

-- AlterTable
ALTER TABLE "research_run" ADD COLUMN     "admitted_day" TEXT,
ADD COLUMN     "admitted_month" TEXT,
ADD COLUMN     "delivery_suppression_reason" TEXT,
ADD COLUMN     "task_id" UUID,
ADD COLUMN     "task_revision" INTEGER,
ADD COLUMN     "trigger" "RunTrigger" NOT NULL DEFAULT 'MANUAL';

-- CreateTable
CREATE TABLE "pricing_version" (
    "version" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_version_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "budget_reservation" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "period_month" TEXT NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'RESERVED',
    "reserved_micros" BIGINT NOT NULL,
    "estimated_micros" BIGINT,
    "uncertain_micros" BIGINT,
    "confirmed_micros" BIGINT,
    "exposure_micros" BIGINT NOT NULL,
    "pricing_version" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "policy" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "budget_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_ledger" (
    "id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "period_month" TEXT NOT NULL,
    "kind" "LedgerKind" NOT NULL,
    "amount_micros" BIGINT NOT NULL,
    "exposure_after_micros" BIGINT NOT NULL,
    "operation_key" TEXT NOT NULL,
    "basis" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" UUID NOT NULL,
    "operation_key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "run_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "budget_reservation_run_id_key" ON "budget_reservation"("run_id");

-- CreateIndex
CREATE INDEX "budget_reservation_user_id_period_month_idx" ON "budget_reservation"("user_id", "period_month");

-- CreateIndex
CREATE INDEX "budget_reservation_period_month_idx" ON "budget_reservation"("period_month");

-- CreateIndex
CREATE UNIQUE INDEX "usage_ledger_operation_key_key" ON "usage_ledger"("operation_key");

-- CreateIndex
CREATE INDEX "usage_ledger_reservation_id_idx" ON "usage_ledger"("reservation_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_event_operation_key_key" ON "outbox_event"("operation_key");

-- CreateIndex
CREATE INDEX "outbox_event_run_id_idx" ON "outbox_event"("run_id");

-- AddForeignKey
ALTER TABLE "research_run" ADD CONSTRAINT "research_run_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_reservation" ADD CONSTRAINT "budget_reservation_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "research_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_reservation" ADD CONSTRAINT "budget_reservation_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_reservation" ADD CONSTRAINT "budget_reservation_pricing_version_fkey" FOREIGN KEY ("pricing_version") REFERENCES "pricing_version"("version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "budget_reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "research_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Constraints, triggers and backfill Prisma cannot express (TRB-050).

-- At most one queued or running run per task (repeated "Run now" returns it instead).
CREATE UNIQUE INDEX "research_run_one_active_per_task" ON "research_run" ("task_id")
  WHERE "task_id" IS NOT NULL AND "state" IN ('QUEUED', 'RUNNING');
ALTER TABLE "research_run" ADD CONSTRAINT "research_run_task_revision"
  CHECK (("task_id" IS NULL) = ("task_revision" IS NULL));
ALTER TABLE "research_run" ADD CONSTRAINT "research_run_period_format"
  CHECK (("admitted_day" IS NULL OR "admitted_day" ~ '^\d{4}-\d{2}-\d{2}$')
     AND ("admitted_month" IS NULL OR "admitted_month" ~ '^\d{4}-\d{2}$'));

-- Existing rows. Admission periods are taken from the recorded creation time
-- (UTC); every existing run was a manual /research run. Existing suppression
-- decisions came from suspensions. No reservation, ledger entry or outbox event
-- is invented for existing runs: they have no accounting (docs/ACCOUNTING.md).
UPDATE "research_run"
   SET "admitted_day" = to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
       "admitted_month" = to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM');
UPDATE "research_run" SET "delivery_suppression_reason" = 'USER_SUSPENDED'
 WHERE "delivery_suppressed_at" IS NOT NULL;
-- Checked after the backfill above.
ALTER TABLE "research_run" ADD CONSTRAINT "research_run_suppression_reason"
  CHECK (("delivery_suppressed_at" IS NULL) = ("delivery_suppression_reason" IS NULL)
     AND ("delivery_suppression_reason" IS NULL
          OR "delivery_suppression_reason" IN ('USER_SUSPENDED', 'TASK_DELETED')));

-- Money: non-negative amounts; exposure matches the status.
ALTER TABLE "budget_reservation" ADD CONSTRAINT "budget_reservation_amounts"
  CHECK ("reserved_micros" > 0 AND "exposure_micros" >= 0
     AND ("estimated_micros" IS NULL OR "estimated_micros" >= 0)
     AND ("uncertain_micros" IS NULL OR "uncertain_micros" >= 0)
     AND ("confirmed_micros" IS NULL OR "confirmed_micros" >= 0));
ALTER TABLE "budget_reservation" ADD CONSTRAINT "budget_reservation_status_exposure"
  CHECK (("status" = 'RESERVED' AND "exposure_micros" = "reserved_micros")
      OR ("status" = 'RELEASED' AND "exposure_micros" = 0)
      OR ("status" = 'SETTLED' AND "estimated_micros" IS NOT NULL AND "uncertain_micros" IS NOT NULL
          AND "exposure_micros" = "estimated_micros" + "uncertain_micros")
      OR ("status" = 'UNRESOLVED' AND "exposure_micros" >= "reserved_micros")
      OR ("status" = 'RESOLVED' AND "confirmed_micros" IS NOT NULL
          AND "exposure_micros" = "confirmed_micros"));
ALTER TABLE "budget_reservation" ADD CONSTRAINT "budget_reservation_period_format"
  CHECK ("period_month" ~ '^\d{4}-\d{2}$');
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_period_format"
  CHECK ("period_month" ~ '^\d{4}-\d{2}$');
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_single_outcome"
  CHECK ("dispatched_at" IS NULL OR "cancelled_at" IS NULL);

-- Only one execution event per run.
CREATE UNIQUE INDEX "outbox_event_one_execution_per_run" ON "outbox_event" ("run_id")
  WHERE "type" = 'RESEARCH_EXECUTE';

-- The ledger, pricing versions and reservation inputs are immutable evidence.
CREATE FUNCTION "usage_ledger_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'usage_ledger is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "usage_ledger_no_update_delete"
  BEFORE UPDATE OR DELETE ON "usage_ledger"
  FOR EACH ROW EXECUTE FUNCTION "usage_ledger_append_only"();

CREATE FUNCTION "pricing_version_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'pricing_version is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pricing_version_no_update_delete"
  BEFORE UPDATE OR DELETE ON "pricing_version"
  FOR EACH ROW EXECUTE FUNCTION "pricing_version_immutable"();

CREATE FUNCTION "budget_reservation_inputs_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."run_id" <> OLD."run_id" OR NEW."user_id" <> OLD."user_id"
     OR NEW."period_month" <> OLD."period_month" OR NEW."reserved_micros" <> OLD."reserved_micros"
     OR NEW."pricing_version" <> OLD."pricing_version" OR NEW."policy_version" <> OLD."policy_version"
     OR NEW."policy" <> OLD."policy" THEN
    RAISE EXCEPTION 'budget_reservation inputs are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "budget_reservation_inputs_immutable"
  BEFORE UPDATE ON "budget_reservation"
  FOR EACH ROW EXECUTE FUNCTION "budget_reservation_inputs_immutable"();

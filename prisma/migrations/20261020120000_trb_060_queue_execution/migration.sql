-- TRB-060: persistent queue execution (pg-boss), research attempts, per-attempt
-- reservations and durable wake-up events. Non-destructive: existing runs,
-- reservations, ledger entries and outbox events are kept; pg-boss owns its own
-- schema ("pgboss" by default), created by the application at startup and never
-- managed by Prisma migrations (docs/QUEUE.md).

-- CreateEnum
CREATE TYPE "AttemptOutcome" AS ENUM ('PROVIDER_TERMINAL', 'NOT_ACCEPTED', 'UNCERTAIN');

-- AlterTable
ALTER TABLE "research_run" ADD COLUMN "current_attempt_no" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "next_attempt_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "budget_reservation" ADD COLUMN "attempt_no" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "outbox_event" ADD COLUMN "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "research_attempt" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "submission_state" "SubmissionState" NOT NULL,
    "outcome" "AttemptOutcome",
    "fencing_token" INTEGER NOT NULL,
    "worker_id" TEXT,
    "submitted_at" TIMESTAMPTZ(3),
    "provider_response_id" TEXT,
    "provider_status" TEXT,
    "provider_model" TEXT,
    "usage" JSONB,
    "tool_call_count" INTEGER,
    "failure_code" TEXT,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "research_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "research_attempt_provider_response_id_key" ON "research_attempt"("provider_response_id");

-- CreateIndex
CREATE UNIQUE INDEX "research_attempt_run_id_attempt_no_key" ON "research_attempt"("run_id", "attempt_no");

-- A run may now hold one reservation per provider submission attempt.
DROP INDEX "budget_reservation_run_id_key";

-- CreateIndex
CREATE UNIQUE INDEX "budget_reservation_run_id_attempt_no_key" ON "budget_reservation"("run_id", "attempt_no");

-- CreateIndex
CREATE INDEX "budget_reservation_run_id_idx" ON "budget_reservation"("run_id");

-- AddForeignKey
ALTER TABLE "research_attempt" ADD CONSTRAINT "research_attempt_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "research_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Constraints Prisma cannot express (TRB-060).

ALTER TABLE "research_run" ADD CONSTRAINT "research_run_attempt_no_positive"
  CHECK ("current_attempt_no" >= 1);
ALTER TABLE "research_attempt" ADD CONSTRAINT "research_attempt_no_positive"
  CHECK ("attempt_no" >= 1);
ALTER TABLE "research_attempt" ADD CONSTRAINT "research_attempt_submitted"
  CHECK ("submission_state" <> 'NOT_SUBMITTED');
ALTER TABLE "budget_reservation" ADD CONSTRAINT "budget_reservation_attempt_no_positive"
  CHECK ("attempt_no" >= 1);
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_type"
  CHECK ("type" IN ('RESEARCH_EXECUTE', 'RESEARCH_WAKE'));

-- At most one undispatched event per run: wake-ups coalesce (earliest time wins).
CREATE UNIQUE INDEX "outbox_event_one_pending_per_run" ON "outbox_event" ("run_id")
  WHERE "dispatched_at" IS NULL AND "cancelled_at" IS NULL;
-- Dispatcher scan.
CREATE INDEX "outbox_event_pending_available" ON "outbox_event" ("available_at")
  WHERE "dispatched_at" IS NULL AND "cancelled_at" IS NULL;

-- The attempt number joins the immutable reservation inputs.
CREATE OR REPLACE FUNCTION "budget_reservation_inputs_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."run_id" <> OLD."run_id" OR NEW."user_id" <> OLD."user_id"
     OR NEW."attempt_no" <> OLD."attempt_no"
     OR NEW."period_month" <> OLD."period_month" OR NEW."reserved_micros" <> OLD."reserved_micros"
     OR NEW."pricing_version" <> OLD."pricing_version" OR NEW."policy_version" <> OLD."policy_version"
     OR NEW."policy" <> OLD."policy" THEN
    RAISE EXCEPTION 'budget_reservation inputs are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Existing rows. Every existing run is its own attempt 1 and every existing
-- reservation belongs to attempt 1 (column default). Runs that reached
-- submission get an attempt record copied from the run's own fields; nothing
-- is invented: the outcome is derived from the recorded state only where the
-- worker's rules make it unambiguous, otherwise left null (open/unclassified).
INSERT INTO "research_attempt" (
  "id", "run_id", "attempt_no", "submission_state", "outcome", "fencing_token", "worker_id",
  "submitted_at", "provider_response_id", "provider_status", "provider_model", "usage",
  "tool_call_count", "failure_code", "completed_at", "created_at", "updated_at")
SELECT gen_random_uuid(), r."id", 1, r."submission_state",
       CASE
         WHEN r."state" = 'UNCERTAIN' THEN 'UNCERTAIN'::"AttemptOutcome"
         WHEN r."state" IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND r."provider_response_id" IS NOT NULL
           THEN 'PROVIDER_TERMINAL'::"AttemptOutcome"
         WHEN r."state" = 'FAILED' AND r."provider_response_id" IS NULL AND r."submission_state" = 'SUBMITTING'
           THEN 'NOT_ACCEPTED'::"AttemptOutcome"
         ELSE NULL
       END,
       r."fencing_token", r."lease_owner", r."submitted_at", r."provider_response_id",
       r."provider_status", r."provider_model", r."usage", r."tool_call_count",
       CASE WHEN r."state" IN ('QUEUED', 'RUNNING') THEN NULL ELSE r."failure_code" END,
       CASE WHEN r."state" IN ('QUEUED', 'RUNNING') THEN NULL ELSE r."completed_at" END,
       COALESCE(r."submitted_at", r."created_at"), now()
  FROM "research_run" r
 WHERE r."submission_state" <> 'NOT_SUBMITTED';

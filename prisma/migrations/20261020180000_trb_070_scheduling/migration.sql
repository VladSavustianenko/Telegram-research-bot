-- TRB-070: persistent scheduling (docs/SCHEDULING.md). Additive: existing runs,
-- attempts, reservations, outbox events and deliveries are not changed. Next
-- occurrences of existing tasks are NOT computed here (DST rules live in the
-- application): the scheduler initializes them to the next future occurrence,
-- so nothing before the start of scheduling is ever executed.

-- CreateEnum
CREATE TYPE "ScheduleDisposition" AS ENUM ('ADMITTED', 'SKIPPED_OVERLAP', 'SKIPPED_DENIED', 'SKIPPED_MISSED');

-- AlterTable
ALTER TABLE "task" ADD COLUMN "next_run_at" TIMESTAMPTZ(3);

-- AlterTable: scheduled runs have no Telegram update; planned occurrence kept separately.
ALTER TABLE "research_run" ALTER COLUMN "source_update_id" DROP NOT NULL,
ADD COLUMN "occurrence_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "schedule_event" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "occurrence_at" TIMESTAMPTZ(3) NOT NULL,
    "disposition" "ScheduleDisposition" NOT NULL,
    "reason" TEXT NOT NULL,
    "run_id" UUID,
    "task_revision" INTEGER NOT NULL,
    "catch_up" BOOLEAN NOT NULL DEFAULT false,
    "lateness_seconds" INTEGER NOT NULL DEFAULT 0,
    "range_end" TIMESTAMPTZ(3),
    "skipped_count" INTEGER,
    "notified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "schedule_event_task_id_created_at_idx" ON "schedule_event"("task_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_event_task_id_occurrence_at_key" ON "schedule_event"("task_id", "occurrence_at");

-- AddForeignKey
ALTER TABLE "schedule_event" ADD CONSTRAINT "schedule_event_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_event" ADD CONSTRAINT "schedule_event_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_event" ADD CONSTRAINT "schedule_event_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "research_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Constraints Prisma cannot express (TRB-070).

-- Only active scheduled tasks have a next occurrence.
ALTER TABLE "task" ADD CONSTRAINT "task_next_run_scheduled"
  CHECK ("next_run_at" IS NULL OR ("state" = 'ACTIVE' AND "schedule_kind" <> 'MANUAL'));
-- Scheduler scan.
CREATE INDEX "task_due" ON "task" ("next_run_at") WHERE "state" = 'ACTIVE' AND "next_run_at" IS NOT NULL;

-- Trigger-specific fields: scheduled runs belong to a task occurrence, manual runs to an update.
ALTER TABLE "research_run" ADD CONSTRAINT "research_run_trigger_fields"
  CHECK ((("trigger" = 'SCHEDULED') = ("occurrence_at" IS NOT NULL))
     AND ("trigger" <> 'SCHEDULED' OR "task_id" IS NOT NULL)
     AND ("trigger" <> 'MANUAL' OR "source_update_id" IS NOT NULL));
-- At most one scheduled run per task and planned occurrence.
CREATE UNIQUE INDEX "research_run_scheduled_occurrence" ON "research_run" ("task_id", "occurrence_at")
  WHERE "trigger" = 'SCHEDULED';

ALTER TABLE "schedule_event" ADD CONSTRAINT "schedule_event_fields"
  CHECK (("disposition" <> 'ADMITTED' OR "run_id" IS NOT NULL)
     AND ("range_end" IS NULL OR "range_end" >= "occurrence_at")
     AND ("skipped_count" IS NULL OR "skipped_count" >= 1)
     AND "lateness_seconds" >= 0);

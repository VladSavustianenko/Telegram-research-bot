-- CreateEnum
CREATE TYPE "TaskState" AS ENUM ('ACTIVE', 'PAUSED', 'DELETED');

-- CreateEnum
CREATE TYPE "ScheduleKind" AS ENUM ('MANUAL', 'DAILY', 'WEEKLY');

-- CreateEnum
CREATE TYPE "DraftMode" AS ENUM ('CREATE', 'EDIT');

-- CreateEnum
CREATE TYPE "DraftSection" AS ENUM ('NAME', 'PROMPT', 'SCHEDULE');

-- CreateEnum
CREATE TYPE "DraftStep" AS ENUM ('NAME', 'PROMPT', 'SCHEDULE_KIND', 'WEEKDAY', 'LOCAL_TIME', 'TIME_ZONE', 'PREVIEW');

-- CreateTable
CREATE TABLE "task" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "schedule_kind" "ScheduleKind" NOT NULL,
    "weekday" INTEGER,
    "local_time" TEXT,
    "time_zone" TEXT NOT NULL,
    "state" "TaskState" NOT NULL DEFAULT 'ACTIVE',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_from_draft_id" UUID,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_draft" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "mode" "DraftMode" NOT NULL,
    "task_id" UUID,
    "section" "DraftSection",
    "base_revision" INTEGER,
    "step" "DraftStep" NOT NULL,
    "data" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "task_draft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "task_created_from_draft_id_key" ON "task"("created_from_draft_id");

-- CreateIndex
CREATE INDEX "task_user_id_state_created_at_idx" ON "task"("user_id", "state", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "task_draft_user_id_key" ON "task_draft"("user_id");

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_draft" ADD CONSTRAINT "task_draft_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_draft" ADD CONSTRAINT "task_draft_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Constraints Prisma cannot express (TRB-040). Existing tables are not changed.

-- Schedule fields exist exactly for the schedule kinds that use them, so a
-- manual task never carries a misleading time or weekday.
ALTER TABLE "task" ADD CONSTRAINT "task_schedule_fields"
  CHECK (("schedule_kind" = 'MANUAL' AND "weekday" IS NULL AND "local_time" IS NULL)
      OR ("schedule_kind" = 'DAILY' AND "weekday" IS NULL AND "local_time" IS NOT NULL)
      OR ("schedule_kind" = 'WEEKLY' AND "weekday" IS NOT NULL AND "local_time" IS NOT NULL));
ALTER TABLE "task" ADD CONSTRAINT "task_weekday_iso" CHECK ("weekday" IS NULL OR "weekday" BETWEEN 1 AND 7);
ALTER TABLE "task" ADD CONSTRAINT "task_local_time_format"
  CHECK ("local_time" IS NULL OR "local_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
ALTER TABLE "task" ADD CONSTRAINT "task_name_length" CHECK (char_length("name") BETWEEN 1 AND 100);
ALTER TABLE "task" ADD CONSTRAINT "task_prompt_present" CHECK (char_length("prompt") >= 1);
ALTER TABLE "task" ADD CONSTRAINT "task_time_zone_present" CHECK (char_length("time_zone") >= 1);
ALTER TABLE "task" ADD CONSTRAINT "task_deleted_consistent"
  CHECK (("state" = 'DELETED') = ("deleted_at" IS NOT NULL));
ALTER TABLE "task" ADD CONSTRAINT "task_revision_positive" CHECK ("revision" >= 1);

-- An edit draft names its task, section and base revision; a creation draft none of them.
ALTER TABLE "task_draft" ADD CONSTRAINT "task_draft_mode_fields"
  CHECK (("mode" = 'CREATE' AND "task_id" IS NULL AND "section" IS NULL AND "base_revision" IS NULL)
      OR ("mode" = 'EDIT' AND "task_id" IS NOT NULL AND "section" IS NOT NULL AND "base_revision" IS NOT NULL));

-- A task belongs to its owner forever.
CREATE FUNCTION "task_owner_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."user_id" <> OLD."user_id" THEN
    RAISE EXCEPTION 'task.user_id is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_owner_immutable"
  BEFORE UPDATE OF "user_id" ON "task"
  FOR EACH ROW EXECUTE FUNCTION "task_owner_immutable"();

-- An edit draft can only target a task of the same user.
CREATE FUNCTION "task_draft_task_owner"() RETURNS trigger AS $$
BEGIN
  IF NEW."task_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "task" t WHERE t."id" = NEW."task_id" AND t."user_id" = NEW."user_id") THEN
    RAISE EXCEPTION 'task_draft.task_id belongs to another user';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_draft_task_owner"
  BEFORE INSERT OR UPDATE OF "task_id", "user_id" ON "task_draft"
  FOR EACH ROW EXECUTE FUNCTION "task_draft_task_owner"();

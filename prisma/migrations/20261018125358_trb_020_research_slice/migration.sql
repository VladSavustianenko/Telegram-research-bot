-- CreateEnum
CREATE TYPE "TelegramUpdateDisposition" AS ENUM ('RUN_ACCEPTED', 'RESULT_REQUESTED', 'REPLIED', 'REJECTED', 'IGNORED');

-- CreateEnum
CREATE TYPE "ResearchRunState" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNCERTAIN');

-- CreateEnum
CREATE TYPE "SubmissionState" AS ENUM ('NOT_SUBMITTED', 'SUBMITTING', 'SUBMITTED');

-- CreateEnum
CREATE TYPE "ResearchOutcome" AS ENUM ('FOUND', 'PARTIAL', 'NO_MATCHES', 'INCONCLUSIVE');

-- CreateEnum
CREATE TYPE "DeliveryKind" AS ENUM ('STATUS', 'REPORT', 'RESEND');

-- CreateEnum
CREATE TYPE "DeliveryState" AS ENUM ('PENDING', 'SENDING', 'SENT', 'RETRYABLE_FAILURE', 'UNKNOWN', 'PERMANENT_FAILURE');

-- CreateEnum
CREATE TYPE "DeliveryPartState" AS ENUM ('PENDING', 'SENDING', 'SENT', 'UNKNOWN', 'FAILED');

-- CreateTable
CREATE TABLE "telegram_update" (
    "update_id" BIGINT NOT NULL,
    "sender_telegram_id" BIGINT,
    "chat_type" TEXT,
    "disposition" "TelegramUpdateDisposition" NOT NULL,
    "reason" TEXT,
    "run_id" UUID,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_update_pkey" PRIMARY KEY ("update_id")
);

-- CreateTable
CREATE TABLE "research_run" (
    "id" UUID NOT NULL,
    "requested_by_telegram_user_id" BIGINT NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "source_update_id" BIGINT NOT NULL,
    "state" "ResearchRunState" NOT NULL DEFAULT 'QUEUED',
    "prompt" TEXT NOT NULL,
    "provider_kind" TEXT NOT NULL,
    "request_snapshot" JSONB NOT NULL,
    "submission_state" "SubmissionState" NOT NULL DEFAULT 'NOT_SUBMITTED',
    "submitted_at" TIMESTAMPTZ(3),
    "provider_response_id" TEXT,
    "provider_status" TEXT,
    "provider_model" TEXT,
    "lease_owner" TEXT,
    "lease_until" TIMESTAMPTZ(3),
    "fencing_token" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "outcome" "ResearchOutcome",
    "report_text" TEXT,
    "citations" JSONB,
    "sources" JSONB,
    "warnings" JSONB,
    "usage" JSONB,
    "tool_call_count" INTEGER,
    "failure_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "research_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery" (
    "id" UUID NOT NULL,
    "run_id" UUID,
    "kind" "DeliveryKind" NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "state" "DeliveryState" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" TEXT,
    "lease_until" TIMESTAMPTZ(3),
    "fencing_token" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_part" (
    "delivery_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "html" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "state" "DeliveryPartState" NOT NULL DEFAULT 'PENDING',
    "telegram_message_id" BIGINT,
    "sent_at" TIMESTAMPTZ(3),

    CONSTRAINT "delivery_part_pkey" PRIMARY KEY ("delivery_id","ordinal")
);

-- CreateIndex
CREATE UNIQUE INDEX "research_run_source_update_id_key" ON "research_run"("source_update_id");

-- CreateIndex
CREATE UNIQUE INDEX "research_run_provider_response_id_key" ON "research_run"("provider_response_id");

-- CreateIndex
CREATE INDEX "research_run_state_created_at_idx" ON "research_run"("state", "created_at");

-- CreateIndex
CREATE INDEX "delivery_state_next_attempt_at_idx" ON "delivery"("state", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "research_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_part" ADD CONSTRAINT "delivery_part_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "delivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Constraints Prisma cannot express (TRB-020).

-- At most one research run executes at a time (prototype global concurrency of one).
CREATE UNIQUE INDEX "research_run_single_running" ON "research_run" ((true)) WHERE "state" = 'RUNNING';

-- A run has at most one automatic report delivery; explicit resends are separate rows.
CREATE UNIQUE INDEX "delivery_report_per_run" ON "delivery" ("run_id") WHERE "kind" = 'REPORT';

-- A response ID exists only once the provider accepted the request.
ALTER TABLE "research_run" ADD CONSTRAINT "research_run_response_id_requires_submission"
  CHECK ("provider_response_id" IS NULL OR "submission_state" = 'SUBMITTED');

-- Terminal runs carry the fields that define them.
ALTER TABLE "research_run" ADD CONSTRAINT "research_run_succeeded_has_report"
  CHECK ("state" <> 'SUCCEEDED' OR ("outcome" IS NOT NULL AND "report_text" IS NOT NULL));
ALTER TABLE "research_run" ADD CONSTRAINT "research_run_failed_has_code"
  CHECK ("state" NOT IN ('FAILED', 'UNCERTAIN') OR "failure_code" IS NOT NULL);

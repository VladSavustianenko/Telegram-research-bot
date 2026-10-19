-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "OnboardingState" AS ENUM ('AWAITING_TIME_ZONE', 'COMPLETED');

-- CreateEnum
CREATE TYPE "AuditEventKind" AS ENUM ('ADMIN_GRANTED', 'ADMIN_REVOKED', 'INVITATION_CREATED', 'INVITATION_REDEEMED', 'USER_SUSPENDED', 'USER_REACTIVATED');

-- AlterEnum
ALTER TYPE "DeliveryKind" ADD VALUE 'INVITATION';

-- AlterEnum
ALTER TYPE "DeliveryState" ADD VALUE 'SUPPRESSED';

-- AlterEnum
ALTER TYPE "ResearchRunState" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "delivery" ADD COLUMN     "invitation_id" UUID;

-- AlterTable
ALTER TABLE "delivery_part" ADD COLUMN     "reply_markup" JSONB;

-- AlterTable
ALTER TABLE "research_run" ADD COLUMN     "user_id" UUID;

-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL,
    "telegram_user_id" BIGINT NOT NULL,
    "private_chat_id" BIGINT,
    "role" "UserRole" NOT NULL DEFAULT 'MEMBER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "onboarding_state" "OnboardingState" NOT NULL DEFAULT 'AWAITING_TIME_ZONE',
    "time_zone" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "invited_at" TIMESTAMPTZ(3),
    "onboarded_at" TIMESTAMPTZ(3),
    "suspended_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "redeemed_by_user_id" UUID,
    "redeemed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL,
    "kind" "AuditEventKind" NOT NULL,
    "actor_user_id" UUID,
    "subject_user_id" UUID,
    "invitation_id" UUID,
    "details" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_user_telegram_user_id_key" ON "app_user"("telegram_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_token_hash_key" ON "invitation"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_redeemed_by_user_id_key" ON "invitation"("redeemed_by_user_id");

-- CreateIndex
CREATE INDEX "audit_event_subject_user_id_created_at_idx" ON "audit_event"("subject_user_id", "created_at");

-- CreateIndex
CREATE INDEX "research_run_user_id_created_at_idx" ON "research_run"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "research_run" ADD CONSTRAINT "research_run_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "invitation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_redeemed_by_user_id_fkey" FOREIGN KEY ("redeemed_by_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_subject_user_id_fkey" FOREIGN KEY ("subject_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "invitation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Constraints Prisma cannot express (TRB-030).
-- Enum values added above are compared as text: they cannot be used as enum
-- literals in the transaction that adds them.

-- Telegram identity is immutable.
CREATE FUNCTION "app_user_identity_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."telegram_user_id" <> OLD."telegram_user_id" THEN
    RAISE EXCEPTION 'app_user.telegram_user_id is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "app_user_identity_immutable"
  BEFORE UPDATE OF "telegram_user_id" ON "app_user"
  FOR EACH ROW EXECUTE FUNCTION "app_user_identity_immutable"();

-- Completed onboarding has a confirmed time zone.
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_onboarded_has_time_zone"
  CHECK ("onboarding_state" <> 'COMPLETED' OR ("time_zone" IS NOT NULL AND "onboarded_at" IS NOT NULL));
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_suspension_consistent"
  CHECK (("status" = 'SUSPENDED') = ("suspended_at" IS NOT NULL));
-- A private chat ID equals the user ID; anything else is not the user's own chat.
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_private_chat_is_own"
  CHECK ("private_chat_id" IS NULL OR "private_chat_id" = "telegram_user_id");

-- Redemption is recorded completely or not at all; only a SHA-256 hex digest is stored.
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_redemption_complete"
  CHECK (("redeemed_at" IS NULL) = ("redeemed_by_user_id" IS NULL));
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_expires_after_creation"
  CHECK ("expires_at" > "created_at");
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_token_hash_format"
  CHECK ("token_hash" ~ '^[0-9a-f]{64}$');

-- Exactly the INVITATION deliveries reference an invitation.
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_invitation_kind"
  CHECK (("kind"::text = 'INVITATION') = ("invitation_id" IS NOT NULL));

-- A run's owner matches its stored Telegram identity and never changes once set.
-- Existing (TRB-020) runs keep user_id NULL here; the application links them by
-- Telegram identity when a user record for that identity is created
-- (administrator bootstrap or invitation redemption). Unknown owners stay NULL.
CREATE FUNCTION "research_run_owner_consistent"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."user_id" IS NOT NULL AND NEW."user_id" IS DISTINCT FROM OLD."user_id" THEN
    RAISE EXCEPTION 'research_run.user_id cannot change once set';
  END IF;
  IF NEW."user_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "app_user" u
        WHERE u."id" = NEW."user_id" AND u."telegram_user_id" = NEW."requested_by_telegram_user_id") THEN
    RAISE EXCEPTION 'research_run.user_id does not match requested_by_telegram_user_id';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "research_run_owner_consistent"
  BEFORE INSERT OR UPDATE OF "user_id", "requested_by_telegram_user_id" ON "research_run"
  FOR EACH ROW EXECUTE FUNCTION "research_run_owner_consistent"();

-- Cancelled runs carry the reason, like failed and uncertain ones.
ALTER TABLE "research_run" DROP CONSTRAINT "research_run_failed_has_code";
ALTER TABLE "research_run" ADD CONSTRAINT "research_run_failed_has_code"
  CHECK ("state"::text NOT IN ('FAILED', 'UNCERTAIN', 'CANCELLED') OR "failure_code" IS NOT NULL);

-- Audit records are append-only.
CREATE FUNCTION "audit_event_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_event_no_update_delete"
  BEFORE UPDATE OR DELETE ON "audit_event"
  FOR EACH ROW EXECUTE FUNCTION "audit_event_append_only"();

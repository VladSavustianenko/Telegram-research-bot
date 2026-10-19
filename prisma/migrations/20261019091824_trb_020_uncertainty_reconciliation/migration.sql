-- CreateEnum
CREATE TYPE "ReconciliationResolution" AS ENUM ('PROVIDER_CONFIRMED_TERMINAL', 'PROVIDER_REQUEST_ABSENT', 'OPERATOR_ACCEPTED_RISK');

-- AlterTable
ALTER TABLE "research_run" ADD COLUMN     "reconciled_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "research_reconciliation" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "operator" TEXT NOT NULL,
    "resolution" "ReconciliationResolution" NOT NULL,
    "note" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_reconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "research_reconciliation_run_id_key" ON "research_reconciliation"("run_id");

-- AddForeignKey
ALTER TABLE "research_reconciliation" ADD CONSTRAINT "research_reconciliation_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "research_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Constraints Prisma cannot express.

-- Reconciliation applies only to UNCERTAIN runs and never changes their state.
ALTER TABLE "research_run" ADD CONSTRAINT "research_run_reconciled_only_uncertain"
  CHECK ("reconciled_at" IS NULL OR "state" = 'UNCERTAIN');

-- Fast check for the fail-closed gate: unresolved live uncertainty blocks live work.
CREATE INDEX "research_run_unreconciled_uncertain" ON "research_run" ("provider_kind")
  WHERE "state" = 'UNCERTAIN' AND "reconciled_at" IS NULL;

-- Audit records are append-only.
CREATE FUNCTION "research_reconciliation_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'research_reconciliation is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "research_reconciliation_no_update_delete"
  BEFORE UPDATE OR DELETE ON "research_reconciliation"
  FOR EACH ROW EXECUTE FUNCTION "research_reconciliation_append_only"();

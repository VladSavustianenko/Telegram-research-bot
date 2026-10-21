-- TRB-100 (docs/OPERATIONS.md): durable execution hold for restored or suspect
-- databases. Additive: a new, empty table; nothing existing changes. An older
-- image ignores the table (it has no hold check), so restoring an older image
-- after this migration is possible but loses the hold protection.

-- CreateTable
CREATE TABLE "operational_hold" (
    "id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "set_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operational_hold_pkey" PRIMARY KEY ("id")
);

-- A single hold row with a bounded, non-empty reason and operator name.
ALTER TABLE "operational_hold" ADD CONSTRAINT "operational_hold_single"
  CHECK ("id" = 'execution');
ALTER TABLE "operational_hold" ADD CONSTRAINT "operational_hold_fields"
  CHECK (length("reason") BETWEEN 1 AND 500 AND length("set_by") BETWEEN 1 AND 100);

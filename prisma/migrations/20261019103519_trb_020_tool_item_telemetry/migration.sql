-- AlterTable
ALTER TABLE "research_run" ADD COLUMN     "tool_telemetry_version" INTEGER;

-- CreateTable
CREATE TABLE "research_tool_item" (
    "run_id" UUID NOT NULL,
    "response_id" TEXT NOT NULL,
    "item_key" TEXT NOT NULL,
    "item_id_reported" BOOLEAN NOT NULL,
    "item_type" TEXT NOT NULL,
    "status" TEXT,
    "action_type" TEXT,
    "observations" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_tool_item_pkey" PRIMARY KEY ("response_id","item_key")
);

-- CreateIndex
CREATE INDEX "research_tool_item_run_id_idx" ON "research_tool_item"("run_id");

-- AddForeignKey
ALTER TABLE "research_tool_item" ADD CONSTRAINT "research_tool_item_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "research_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Telemetry version marker: NULL (not recorded, e.g. runs before this migration) or 1.
ALTER TABLE "research_run" ADD CONSTRAINT "research_run_tool_telemetry_version_known"
  CHECK ("tool_telemetry_version" IS NULL OR "tool_telemetry_version" = 1);

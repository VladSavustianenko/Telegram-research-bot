-- TRB-100 review fix (docs/OPERATIONS.md, "Restore"): audit evidence of operator
-- quarantine decisions on a restored database. Additive: two new enum values;
-- existing rows are unchanged.

-- AlterEnum
ALTER TYPE "AuditEventKind" ADD VALUE 'RESTORE_RUN_QUARANTINED';
ALTER TYPE "AuditEventKind" ADD VALUE 'RESTORE_DELIVERY_SUPPRESSED';

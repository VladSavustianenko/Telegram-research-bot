import type { Tx } from '../database/prisma-errors';
import type { PrismaService } from '../database/prisma.service';
import type { ObservedToolItem } from './provider/provider.types';

/**
 * Diagnostic tool telemetry (TRB-020 follow-up).
 *
 * Names are deliberately distinct:
 * - observed tool items: distinct web_search_call output items seen in any
 *   snapshot of the run's provider response (deduplicated by response ID and
 *   item ID);
 * - observed items by status / action: their latest reported values, verbatim;
 * - billable search count: unknown. Provider output does not state what is
 *   billed; only billing evidence can establish it, so it is never derived here.
 */
export const TOOL_TELEMETRY_VERSION = 1;

/** Items without a provider ID are keyed by output position (deduplication is best-effort). */
export function toolItemKey(item: ObservedToolItem): string {
  return item.itemId ?? `missing-id:${item.position}`;
}

/**
 * Upserts the items of one snapshot. A repeated item updates its latest
 * status/action (missing values never overwrite reported ones) and is not
 * counted again. Items omitted by a later snapshot keep their rows. Call inside
 * the worker's fenced transaction.
 */
export async function recordToolItems(
  tx: Tx,
  runId: string,
  responseId: string,
  items: readonly ObservedToolItem[],
): Promise<void> {
  for (const item of items) {
    await tx.$executeRaw`
      INSERT INTO research_tool_item
             (run_id, response_id, item_key, item_id_reported, item_type, status, action_type)
      VALUES (${runId}::uuid, ${responseId}, ${toolItemKey(item)}, ${item.itemId !== null},
              ${item.type}, ${item.status}, ${item.actionType})
      ON CONFLICT (response_id, item_key) DO UPDATE SET
             status = COALESCE(EXCLUDED.status, research_tool_item.status),
             action_type = COALESCE(EXCLUDED.action_type, research_tool_item.action_type),
             observations = research_tool_item.observations + 1,
             last_seen_at = now()`;
  }
}

const UNREPORTED = 'unreported';

export interface ToolTelemetrySummary {
  runId: string;
  /** "not_recorded": the run predates per-item telemetry; per-item facts are unknown. */
  telemetry: 'recorded' | 'not_recorded';
  /** Historical research_run.tool_call_count (web_search_call output items in the final snapshot). */
  webSearchCallOutputItemsFinalSnapshot: number | null;
  observedToolItems: number | null;
  observedItemsByStatus: Record<string, number> | null;
  observedItemsByAction: Record<string, number> | null;
  observedItemsByStatusAndAction: { status: string; actionType: string; items: number }[] | null;
  itemsWithoutProviderId: number | null;
  billableSearchCount: null;
  billableSearchCountNote: string;
}

export async function summarizeToolTelemetry(
  prisma: PrismaService,
  runId: string,
): Promise<ToolTelemetrySummary | null> {
  const run = await prisma.researchRun.findUnique({
    where: { id: runId },
    select: { id: true, toolCallCount: true, toolTelemetryVersion: true },
  });
  if (!run) return null;
  const base = {
    runId: run.id,
    webSearchCallOutputItemsFinalSnapshot: run.toolCallCount,
    billableSearchCount: null,
    billableSearchCountNote:
      'Unknown: provider output does not state which tool actions are billed; requires billing evidence.',
  } as const;
  if (run.toolTelemetryVersion === null) {
    return {
      ...base,
      telemetry: 'not_recorded',
      observedToolItems: null,
      observedItemsByStatus: null,
      observedItemsByAction: null,
      observedItemsByStatusAndAction: null,
      itemsWithoutProviderId: null,
    };
  }
  const items = await prisma.researchToolItem.findMany({
    where: { runId },
    select: { status: true, actionType: true, itemIdReported: true },
  });
  const byStatus: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  const byBoth = new Map<string, { status: string; actionType: string; items: number }>();
  for (const item of items) {
    const status = item.status ?? UNREPORTED;
    const actionType = item.actionType ?? UNREPORTED;
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    byAction[actionType] = (byAction[actionType] ?? 0) + 1;
    const key = `${status}\u0000${actionType}`;
    const entry = byBoth.get(key) ?? { status, actionType, items: 0 };
    entry.items += 1;
    byBoth.set(key, entry);
  }
  return {
    ...base,
    telemetry: 'recorded',
    observedToolItems: items.length,
    observedItemsByStatus: byStatus,
    observedItemsByAction: byAction,
    observedItemsByStatusAndAction: [...byBoth.values()].sort(
      (a, b) => a.status.localeCompare(b.status) || a.actionType.localeCompare(b.actionType),
    ),
    itemsWithoutProviderId: items.filter((item) => !item.itemIdReported).length,
  };
}

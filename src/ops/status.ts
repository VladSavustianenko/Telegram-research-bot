import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { ConfigValidationError, type Env } from '../config/env.schema';
import { loadConfig } from '../config/load-config';
import { PrismaService } from '../database/prisma.service';
import { readHold } from '../operations/hold';
import { readSchemaState, schemaReady } from '../operations/schema-state';

/**
 * Read-only operational diagnostics (TRB-100, docs/OPERATIONS.md).
 *   node dist/ops/status.js              full report (JSON), exit 0
 *   node dist/ops/status.js --quiesced   exit 0 only when no process is executing:
 *                                        no live research lease, no delivery
 *                                        being sent, no active queue job
 * Reports counts, ages and identifiers only: never prompts, reports, message
 * text, chat content or secrets. Never contacts OpenAI or Telegram and never
 * changes anything.
 */

type Row = Record<string, unknown>;

/** Lag after which due outbox events count as stalled (dispatchers run every few seconds). */
const OUTBOX_LAG_WARN_SECONDS = 120;

async function rows(prisma: PrismaService, sql: string): Promise<Row[]> {
  return prisma.$queryRawUnsafe<Row[]>(sql);
}

async function one(prisma: PrismaService, sql: string): Promise<Row> {
  return (await rows(prisma, sql))[0] ?? {};
}

const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

async function queueSection(prisma: PrismaService, schema: string) {
  const [exists] = await rows(prisma, `SELECT to_regclass('${schema}.job') IS NOT NULL AS exists`);
  if (!exists?.['exists']) return { installed: false, schemaVersion: null, openJobs: [] as Row[] };
  const version = await one(prisma, `SELECT version FROM "${schema}".version`);
  const jobs = await rows(
    prisma,
    `SELECT name, state::text AS state, count(*)::int AS count,
            round(extract(epoch FROM now() - min(created_on)))::int AS "oldestAgeSeconds"
       FROM "${schema}".job
      WHERE state IN ('created', 'retry', 'active')
      GROUP BY name, state ORDER BY name, state`,
  );
  return { installed: true, schemaVersion: num(version['version']), openJobs: jobs };
}

async function report(prisma: PrismaService, config: Env) {
  const schema = await readSchemaState(prisma);
  if (!schemaReady(schema)) {
    // The data queries below need this build's schema; report what is safe to read.
    let hold: unknown;
    try {
      hold = await readHold(prisma);
    } catch {
      hold = 'UNREADABLE';
    }
    return {
      generatedAt: new Date().toISOString(),
      warnings: [
        'SCHEMA_NOT_AT_THIS_BUILD',
        ...(schema.unknown.length > 0 ? ['DATABASE_NEWER_THAN_BUILD'] : []),
      ],
      schema,
      hold,
      queue: await queueSection(prisma, config.QUEUE_SCHEMA),
      note: 'Other sections need the schema of this build (run the migration step first).',
    };
  }
  const hold = await readHold(prisma);
  const pollSeconds = config.SCHEDULER_POLL_INTERVAL_SECONDS;

  const research = {
    byState: await rows(
      prisma,
      `SELECT state::text AS state, count(*)::int AS count FROM research_run GROUP BY state ORDER BY state`,
    ),
    oldestQueuedAgeSeconds: num(
      (
        await one(
          prisma,
          `SELECT round(extract(epoch FROM now() - min(created_at)))::int AS age
             FROM research_run WHERE state = 'QUEUED'`,
        )
      )['age'],
    ),
    running: await rows(
      prisma,
      `SELECT id, provider_kind AS "providerKind", submission_state::text AS "submissionState",
              lease_owner AS "leaseOwner", lease_until AS "leaseUntil",
              (lease_until IS NULL OR lease_until < now()) AS "leaseExpired",
              provider_response_id IS NOT NULL AS "hasResponseId", submitted_at AS "submittedAt"
         FROM research_run WHERE state = 'RUNNING'`,
    ),
    uncertainUnreconciled: await rows(
      prisma,
      `SELECT id, provider_kind AS "providerKind", failure_code AS "failureCode",
              provider_response_id AS "providerResponseId", submitted_at AS "submittedAt"
         FROM research_run
        WHERE state = 'UNCERTAIN' AND reconciled_at IS NULL
        ORDER BY created_at LIMIT 50`,
    ),
  };

  const outbox = async (table: string) =>
    one(
      prisma,
      `SELECT count(*) FILTER (WHERE available_at <= now())::int AS due,
              count(*) FILTER (WHERE available_at > now())::int AS deferred,
              round(extract(epoch FROM now() - min(available_at)
                    FILTER (WHERE available_at <= now())))::int AS "oldestDueAgeSeconds"
         FROM ${table} WHERE dispatched_at IS NULL AND cancelled_at IS NULL`,
    );

  const scheduler = await one(
    prisma,
    `SELECT count(*) FILTER (WHERE next_run_at < now() - ${pollSeconds * 2} * interval '1 second')::int
              AS "overdueTasks",
            round(extract(epoch FROM now() - min(next_run_at)))::int AS "maxLagSeconds",
            count(*) FILTER (WHERE next_run_at IS NULL)::int AS "uninitializedTasks",
            (SELECT max(created_at) FROM schedule_event) AS "lastScheduleEventAt"
       FROM task WHERE state = 'ACTIVE' AND schedule_kind <> 'MANUAL'`,
  );

  const delivery = {
    byState: await rows(
      prisma,
      `SELECT state::text AS state, count(*)::int AS count,
              count(*) FILTER (WHERE updated_at > now() - interval '7 days')::int AS "last7Days"
         FROM delivery GROUP BY state ORDER BY state`,
    ),
    sending: await rows(
      prisma,
      `SELECT id, lease_owner AS "leaseOwner", lease_until AS "leaseUntil",
              (lease_until IS NULL OR lease_until < now()) AS "leaseExpired"
         FROM delivery WHERE state = 'SENDING'`,
    ),
    pendingDestinationBlocks: await rows(
      prisma,
      `SELECT id, destination_block_reason AS reason, destination_refused_at AS "refusedAt"
         FROM delivery
        WHERE destination_block_reason IS NOT NULL AND destination_block_applied_at IS NULL`,
    ),
  };

  const accounting = {
    reservations: await rows(
      prisma,
      `SELECT status::text AS status, count(*)::int AS count,
              sum(exposure_micros)::text AS "exposureMicros"
         FROM budget_reservation GROUP BY status ORDER BY status`,
    ),
    currentMonth: await one(
      prisma,
      `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
              COALESCE(sum(exposure_micros), 0)::text AS "exposureMicros"
         FROM budget_reservation
        WHERE period_month = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')`,
    ),
    settledWithUncertainSearches: num(
      (
        await one(
          prisma,
          `SELECT count(*)::int AS n FROM budget_reservation
            WHERE status = 'SETTLED' AND uncertain_micros > 0`,
        )
      )['n'],
    ),
    deniedLast24h: await rows(
      prisma,
      `SELECT 'telegram' AS source, reason, count(*)::int AS count FROM telegram_update
        WHERE disposition = 'REJECTED' AND reason IS NOT NULL
          AND received_at > now() - interval '24 hours'
        GROUP BY reason
       UNION ALL
       SELECT 'schedule', reason, count(*)::int FROM schedule_event
        WHERE disposition = 'SKIPPED_DENIED' AND created_at > now() - interval '24 hours'
        GROUP BY reason
       ORDER BY count DESC`,
    ),
  };

  const retention = {
    cleanup: config.RETENTION_CLEANUP,
    reportRetentionDays: config.REPORT_RETENTION_DAYS,
    metadataRetentionDays: config.METADATA_RETENTION_DAYS,
    ...(await one(
      prisma,
      `SELECT
         (SELECT count(*)::int FROM research_run
           WHERE content_purged_at IS NULL
             AND state IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN')
             AND COALESCE(completed_at, updated_at)
                 < now() - ${config.REPORT_RETENTION_DAYS} * interval '1 day') AS "runsPastRetention",
         (SELECT count(*)::int FROM research_run WHERE content_purged_at IS NOT NULL) AS "runsPurged",
         (SELECT count(*)::int FROM telegram_update WHERE metadata_redacted_at IS NOT NULL)
           AS "inboxTombstones",
         (SELECT count(*)::int FROM telegram_update) AS "inboxRecords"`,
    )),
  };

  const queue = await queueSection(prisma, config.QUEUE_SCHEMA);
  const researchOutbox = await outbox('outbox_event');
  const deliveryOutbox = await outbox('delivery_event');

  const warnings: string[] = [];
  if (!schemaReady(schema)) warnings.push('SCHEMA_NOT_AT_THIS_BUILD');
  if (schema.unknown.length > 0) warnings.push('DATABASE_NEWER_THAN_BUILD');
  if (hold) warnings.push('OPERATIONAL_HOLD_SET');
  if (research.uncertainUnreconciled.length > 0) warnings.push('UNCERTAIN_RUNS_UNRECONCILED');
  if (research.running.some((run) => run['leaseExpired'])) warnings.push('RESEARCH_LEASE_EXPIRED');
  if (delivery.sending.some((row) => row['leaseExpired'])) warnings.push('DELIVERY_LEASE_EXPIRED');
  if (delivery.pendingDestinationBlocks.length > 0) warnings.push('DESTINATION_BLOCK_PENDING');
  if (delivery.byState.some((row) => row['state'] === 'UNKNOWN' && Number(row['last7Days']) > 0)) {
    warnings.push('DELIVERY_UNKNOWN_RECENT');
  }
  if (accounting.reservations.some((row) => row['status'] === 'UNRESOLVED')) {
    warnings.push('ACCOUNTING_UNRESOLVED');
  }
  for (const [name, lag] of [
    ['RESEARCH_OUTBOX_LAG', researchOutbox['oldestDueAgeSeconds']],
    ['DELIVERY_OUTBOX_LAG', deliveryOutbox['oldestDueAgeSeconds']],
  ] as const) {
    if (Number(lag ?? 0) > OUTBOX_LAG_WARN_SECONDS) warnings.push(name);
  }
  if (Number(scheduler['overdueTasks'] ?? 0) > 0) warnings.push('SCHEDULER_LAG');

  return {
    generatedAt: new Date().toISOString(),
    warnings,
    schema,
    hold,
    queue,
    research: { ...research, outbox: researchOutbox },
    scheduler,
    delivery: { ...delivery, outbox: deliveryOutbox },
    accounting,
    retention,
  };
}

/** No live lease, no part in flight, no active job: no process is executing work. */
async function quiesced(prisma: PrismaService, config: Env) {
  const state = await one(
    prisma,
    `SELECT
       (SELECT count(*)::int FROM research_run WHERE state = 'RUNNING' AND lease_until > now())
         AS "liveResearchLeases",
       (SELECT count(*)::int FROM delivery WHERE state = 'SENDING' AND lease_until > now())
         AS "liveDeliveryLeases"`,
  );
  const queue = await queueSection(prisma, config.QUEUE_SCHEMA);
  const activeJobs = queue.openJobs
    .filter((job) => job['state'] === 'active')
    .reduce((sum, job) => sum + Number(job['count']), 0);
  const result = { ...state, activeQueueJobs: activeJobs };
  const idle = Object.values(result).every((value) => Number(value) === 0);
  return { quiesced: idle, ...result };
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { quiesced: { type: 'boolean' } } });
  const config = loadConfig();
  const prisma = new PrismaService(config);
  try {
    const result = values.quiesced ? await quiesced(prisma, config) : await report(prisma, config);
    process.stdout.write(
      `${JSON.stringify(result, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value), 2)}\n`,
    );
    return values.quiesced && !(result as { quiesced: boolean }).quiesced ? 1 : 0;
  } finally {
    await prisma.onApplicationShutdown();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof ConfigValidationError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      const code = (error as { code?: unknown }).code;
      process.stderr.write(
        `Failed: ${error instanceof Error ? error.name : 'unknown error'}${typeof code === 'string' ? ` (${code})` : ''}\n`,
      );
    }
    process.exit(1);
  },
);

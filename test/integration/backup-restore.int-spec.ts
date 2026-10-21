import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, describe, expect, inject, it, vi } from 'vitest';
import { resolveRun } from '../../src/accounting/ledger';
import { clearHold, readHold, setHold } from '../../src/operations/hold';
import { readSchemaState } from '../../src/operations/schema-state';
import { reconcileUncertainRun } from '../../src/research/reconciliation';
import { telegramBlocked, telegramTimeout, unknownOutcome } from '../support/fakes';
import { LIVE_TEST_ENV } from '../support/live-env';
import {
  ADMIN_ID,
  OTHER_ADMIN_ID,
  drainDeliveries,
  privateMessage,
  resetDatabase,
  startHarness,
  type Harness,
} from '../support/research-harness';

// TRB-100 backup and restore (docs/OPERATIONS.md, "Backup and restore").
// Builds synthetic state covering accounting, reconciliation, inbox tombstones,
// delivery states, recorded refusals, schedules and pending work; dumps it with
// pg_dump, restores it into a NEW database with pg_restore, verifies it, and
// starts the application on the restored copy under an operational hold.
//
// The PostgreSQL client tools must match the server's major version, so they
// run inside the test server's container: set TRB_PG_TOOLS_CONTAINER (for the
// local compose setup: telegram-research-bot-postgres-test-1). Without it the
// suite is skipped; it never touches any other database.

const CONTAINER = process.env['TRB_PG_TOOLS_CONTAINER'];
const DAY = 86_400_000;

function tool(args: string[], input?: Buffer): Buffer {
  const result = spawnSync('docker', ['exec', '-i', CONTAINER ?? '', ...args], {
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${args[0]} failed: ${result.stderr.toString('utf8').slice(0, 500)}`);
  }
  return result.stdout;
}

/** Content hash of every table in both schemas, plus the migration names. */
async function fingerprint(url: string): Promise<Record<string, string>> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const tables = await client.query<{ name: string }>(
      `SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables
        WHERE schemaname IN ('public', 'pgboss') AND tablename <> '_prisma_migrations'
        ORDER BY 1`,
    );
    const result: Record<string, string> = {};
    for (const { name } of tables.rows) {
      const row = await client.query<{ hash: string | null; n: string }>(
        `SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS hash, count(*)::text AS n FROM ${name} t`,
      );
      result[name] = `${row.rows[0]?.n}:${row.rows[0]?.hash ?? '-'}`;
    }
    const migrations = await client.query<{ names: string }>(
      `SELECT string_agg(migration_name, ',' ORDER BY migration_name) AS names
         FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    );
    result['_prisma_migrations'] = migrations.rows[0]?.names ?? '';
    return result;
  } finally {
    await client.end();
  }
}

describe.skipIf(!CONTAINER)('TRB-100 backup → isolated restore → verification', () => {
  const sourceUrl = new URL(inject('databaseUrl'));
  const restoredName = `trb_restore_${Date.now()}_${randomBytes(4).toString('hex')}`;
  const restoredUrl = new URL(sourceUrl.toString());
  restoredUrl.pathname = `/${restoredName}`;
  const open: Harness[] = [];

  afterAll(async () => {
    for (const harness of open.splice(0)) await harness.close();
    const admin = new URL(sourceUrl.toString());
    admin.pathname = '/postgres';
    const client = new Client({ connectionString: admin.toString() });
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS "${restoredName}" WITH (FORCE)`);
    await client.end();
  });

  it('restores every record and starts quarantined; external work stays safe', async () => {
    // ---- synthetic state in the disposable source database
    const live = await startHarness(LIVE_TEST_ENV);
    open.push(live);
    await resetDatabase(live.prisma);
    const say = (text: string, from = ADMIN_ID) =>
      live.post(privateMessage(text, from)).expect(200);

    // 1. settled live run, report delivered (confirmed Telegram message IDs)
    await say('/research settled');
    await live.research.tick();
    await drainDeliveries(live);
    // 2. ambiguous submission, research-reconciled and financially resolved
    live.provider.onSubmit = () => Promise.reject(unknownOutcome());
    await say('/research resolved later');
    await live.research.tick();
    const [, resolved] = await live.prisma.researchRun.findMany({ orderBy: { createdAt: 'asc' } });
    await reconcileUncertainRun(live.prisma, {
      runId: resolved!.id,
      resolution: 'OPERATOR_ACCEPTED_RISK',
      operator: 'owner',
      note: 'synthetic',
    });
    await live.prisma.$transaction((tx) =>
      resolveRun(tx, {
        runId: resolved!.id,
        confirmedMicros: 120_000n,
        operator: 'owner',
        note: 'x',
      }),
    );
    await drainDeliveries(live);
    // 3. retention: old content purged, inbox reduced to tombstones
    live.clock.advance(91 * DAY);
    await live.retention.runPass();
    // 4. ambiguous submission left UNRESOLVED and unreconciled (blocks live work)
    await say('/research left uncertain');
    await live.research.tick();
    // 5. an ambiguous Telegram send (UNKNOWN), a recorded refusal not yet applied
    live.sender.failNext(telegramTimeout());
    await say('/help');
    await drainDeliveries(live);
    live.sender.failNext(telegramBlocked());
    await say('/help', OTHER_ADMIN_ID);
    await drainDeliveries(live);
    await live.prisma.$executeRaw`
      UPDATE delivery SET destination_block_applied_at = NULL
       WHERE destination_block_reason IS NOT NULL`; // as after a crash before applying it
    // 6. a scheduled task, a queued run and a pending reply (pending work)
    const owner = await live.prisma.appUser.findUniqueOrThrow({
      where: { telegramUserId: BigInt(ADMIN_ID) },
    });
    await live.prisma.task.create({
      data: {
        userId: owner.id,
        name: 'daily',
        prompt: 'synthetic',
        scheduleKind: 'DAILY',
        localTime: '09:00',
        timeZone: 'Europe/Kyiv',
        nextRunAt: new Date(Date.now() + DAY),
      },
    });
    await say('/research queued at backup time', OTHER_ADMIN_ID);
    await say('/tasks');
    await live.close();
    open.splice(0);

    const summary = async (url: string) => {
      const client = new Client({ connectionString: url });
      await client.connect();
      try {
        const q = async (sql: string) => (await client.query(sql)).rows as unknown[];
        return {
          exposure: await q(
            `SELECT status::text, count(*)::int, sum(exposure_micros)::text FROM budget_reservation GROUP BY 1 ORDER BY 1`,
          ),
          ledger: await q(
            `SELECT kind::text, sum(amount_micros)::text FROM usage_ledger GROUP BY 1 ORDER BY 1`,
          ),
          reconciliations: await q(`SELECT count(*)::int FROM research_reconciliation`),
          runs: await q(
            `SELECT state::text, submission_state::text, reconciled_at IS NOT NULL AS reconciled,
                    content_purged_at IS NOT NULL AS purged, count(*)::int
               FROM research_run GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`,
          ),
          tombstones: await q(
            `SELECT count(*) FILTER (WHERE metadata_redacted_at IS NOT NULL)::int, count(*)::int FROM telegram_update`,
          ),
          deliveries: await q(
            `SELECT state::text, last_error_code, count(*)::int FROM delivery GROUP BY 1, 2 ORDER BY 1, 2`,
          ),
          confirmedParts: await q(
            `SELECT string_agg(telegram_message_id::text, ',' ORDER BY telegram_message_id)
               FROM delivery_part WHERE telegram_message_id IS NOT NULL`,
          ),
          purgedParts: await q(
            `SELECT count(*)::int FROM delivery_part WHERE content_purged_at IS NOT NULL`,
          ),
          pendingRefusals: await q(
            `SELECT count(*)::int FROM delivery
              WHERE destination_block_reason IS NOT NULL AND destination_block_applied_at IS NULL`,
          ),
          schedules: await q(`SELECT schedule_kind::text, local_time, next_run_at FROM task`),
          waitingParts: await q(
            `SELECT count(*)::int FROM delivery_part p JOIN delivery d ON d.id = p.delivery_id
              WHERE d.state IN ('PENDING', 'RETRYABLE_FAILURE') AND p.state = 'PENDING'`,
          ),
          pendingEvents: await q(
            `SELECT (SELECT count(*) FROM outbox_event WHERE dispatched_at IS NULL AND cancelled_at IS NULL)::int,
                    (SELECT count(*) FROM delivery_event WHERE dispatched_at IS NULL AND cancelled_at IS NULL)::int`,
          ),
        };
      } finally {
        await client.end();
      }
    };

    const before = await fingerprint(sourceUrl.toString());
    const beforeSummary = await summary(sourceUrl.toString());
    // The state covers what the procedure must preserve.
    expect(JSON.stringify(beforeSummary.exposure)).toContain('UNRESOLVED');
    expect(JSON.stringify(beforeSummary.exposure)).toContain('RESOLVED');
    expect(JSON.stringify(beforeSummary.deliveries)).toContain('UNKNOWN');
    expect(JSON.stringify(beforeSummary.deliveries)).toContain('PENDING');
    expect(beforeSummary.pendingRefusals).toEqual([{ count: 1 }]);
    expect((beforeSummary.tombstones[0] as { count: number }).count).toBeGreaterThan(0);
    expect((beforeSummary.purgedParts[0] as { count: number }).count).toBeGreaterThan(0);

    // ---- backup (custom format, both schemas) and restore into a new database
    const db = sourceUrl.pathname.slice(1);
    const user = decodeURIComponent(sourceUrl.username);
    const dump = tool([
      'pg_dump',
      '-U',
      user,
      '-d',
      db,
      '--format=custom',
      '--no-owner',
      '--no-privileges',
    ]);
    expect(dump.length).toBeGreaterThan(1_000);
    tool(['createdb', '-U', user, restoredName]);
    tool(
      [
        'pg_restore',
        '-U',
        user,
        '-d',
        restoredName,
        '--no-owner',
        '--no-privileges',
        '--exit-on-error',
        '--single-transaction',
      ],
      dump,
    );

    // ---- verification of the restored copy
    expect(await fingerprint(restoredUrl.toString())).toEqual(before);
    expect(await summary(restoredUrl.toString())).toEqual(beforeSummary);

    // Quarantine before any application process connects to the restored copy.
    const verifier = await startHarness({}, { databaseUrl: restoredUrl.toString() });
    open.push(verifier);
    const state = await readSchemaState(verifier.prisma);
    expect(state).toMatchObject({ pending: [], failed: [], unknown: [] });
    await setHold(verifier.prisma, { reason: 'restored from backup', setBy: 'test' });

    const restored = await startHarness(
      { ...LIVE_TEST_ENV, BACKGROUND_WORKERS: 'on', WORKER_POLL_INTERVAL_MS: '50' },
      { databaseUrl: restoredUrl.toString() },
    );
    open.push(restored);
    expect(restored.gate.state).toBe('held');
    await restored.post(privateMessage('/help')).expect(503); // ingress closed; Telegram keeps it
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(restored.provider.calls).toEqual({ submit: 0, retrieve: 0, cancel: 0 });
    expect(restored.sender.attempts).toHaveLength(0);
    expect(await summary(restoredUrl.toString())).toEqual(beforeSummary);

    // After the operator's checks: clear the hold. The unreconciled live UNCERTAIN
    // run still keeps live research closed; queued live work does not start.
    expect(await clearHold(verifier.prisma)).toBe(true);
    expect(await readHold(verifier.prisma)).toBeNull();
    expect(await restored.gate.evaluateNow()).toBe('open');
    await vi.waitFor(
      async () =>
        expect(
          await restored.prisma.delivery.count({
            where: { destinationBlockReason: { not: null }, destinationBlockAppliedAt: null },
          }),
        ).toBe(0),
      { timeout: 10_000 },
    );
    await vi.waitFor(
      async () =>
        expect(await restored.prisma.delivery.count({ where: { state: 'PENDING' } })).toBe(0),
      { timeout: 10_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(restored.provider.calls.submit).toBe(0);
    const after = await summary(restoredUrl.toString());
    expect(after.exposure).toEqual(beforeSummary.exposure); // accounting unchanged
    expect(after.ledger).toEqual(beforeSummary.ledger);
    const confirmedBefore = String(
      (beforeSummary.confirmedParts[0] as { string_agg: string }).string_agg,
    ).split(',');
    const confirmedAfter = String(
      (after.confirmedParts[0] as { string_agg: string }).string_agg,
    ).split(',');
    expect(confirmedAfter).toEqual(expect.arrayContaining(confirmedBefore)); // …and never resent
    // Each part still waiting at backup time was attempted once; nothing confirmed was resent.
    const waiting = (beforeSummary.waitingParts[0] as { count: number }).count;
    expect(waiting).toBeGreaterThan(0);
    expect(restored.sender.attempts).toHaveLength(waiting);
    expect(JSON.stringify(after.deliveries)).toContain('UNKNOWN'); // ambiguous send stays UNKNOWN
    expect(after.runs).toEqual(beforeSummary.runs); // queued live run waits; nothing resubmitted

    // A replay of an update processed before the backup is still a duplicate.
    const inboxBefore = await restored.prisma.telegramUpdate.count();
    const oldest = await restored.prisma.telegramUpdate.findFirstOrThrow({
      orderBy: { updateId: 'asc' },
    });
    await restored
      .post(privateMessage('/research replayed', ADMIN_ID, Number(oldest.updateId)))
      .expect(200);
    expect(await restored.prisma.telegramUpdate.count()).toBe(inboxBefore);
    expect(after.runs).toEqual((await summary(restoredUrl.toString())).runs);
  }, 120_000);
});

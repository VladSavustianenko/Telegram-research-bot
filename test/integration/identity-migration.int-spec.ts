import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasUnresolvedLiveUncertainty } from '../../src/research/uncertainty';
import { timeZoneCallbackData } from '../../src/telegram/callback-data';
import {
  callbackQuery,
  drainDeliveries,
  privateMessage,
  startHarness,
  type Harness,
} from '../support/research-harness';
import { disposableDatabaseName, withDatabase } from '../support/test-database';
import { inject } from 'vitest';

const MIGRATIONS = join(process.cwd(), 'prisma', 'migrations');
const TRB_030 = '20261019111654_trb_030_identity';
const ADMIN = 1001;
/** A TRB-020 requester who is no longer configured as an administrator. */
const FORMER_ADMIN = 7007;

const R1 = '00000000-0000-4000-8000-000000000001'; // admin, live, SUCCEEDED, report + resend + tool items
const R2 = '00000000-0000-4000-8000-000000000002'; // admin, live, UNCERTAIN, reconciled
const R3 = '00000000-0000-4000-8000-000000000003'; // former admin, live, UNCERTAIN, unreconciled
const R4 = '00000000-0000-4000-8000-000000000004'; // former admin, fake, SUCCEEDED
const R5 = '00000000-0000-4000-8000-000000000005'; // former admin, fake, QUEUED
const REPORT = '00000000-0000-4000-8000-0000000000a1';
const RESEND = '00000000-0000-4000-8000-0000000000a2';
const REPORT_R4 = '00000000-0000-4000-8000-0000000000a4';

/** TRB-020 data as the previous schema stored it (no users, no owners). */
const TRB_020_RECORDS = `
INSERT INTO telegram_update (update_id, sender_telegram_id, chat_type, disposition, reason, run_id) VALUES
  (11, ${ADMIN}, 'private', 'RUN_ACCEPTED', NULL, '${R1}'),
  (12, ${ADMIN}, 'private', 'RESULT_REQUESTED', NULL, '${R1}'),
  (13, ${FORMER_ADMIN}, 'private', 'RUN_ACCEPTED', NULL, '${R4}'),
  (14, NULL, NULL, 'IGNORED', 'UNSUPPORTED_UPDATE', NULL);
INSERT INTO research_run (id, requested_by_telegram_user_id, chat_id, source_update_id, state, prompt, provider_kind,
                          request_snapshot, submission_state, submitted_at, provider_response_id, provider_status,
                          provider_model, outcome, report_text, citations, sources, usage, tool_call_count,
                          tool_telemetry_version, failure_code, created_at, updated_at, completed_at, reconciled_at) VALUES
  ('${R1}', ${ADMIN}, ${ADMIN}, 11, 'SUCCEEDED', 'p1', 'openai', '{"config":{"providerKind":"openai"}}', 'SUBMITTED',
   '2026-10-19 10:54:57+00', 'resp_live_1', 'completed', 'gpt-5.5-2026-04-23', 'FOUND', 'OUTCOME: FOUND\nr1', '[]', '[]',
   '{"inputTokens":23358}', 3, 1, NULL, '2026-10-19 10:54:50+00', '2026-10-19 10:55:20+00', '2026-10-19 10:55:19+00', NULL),
  ('${R2}', ${ADMIN}, ${ADMIN}, 21, 'UNCERTAIN', 'p2', 'openai', '{"config":{"providerKind":"openai"}}', 'SUBMITTING',
   '2026-10-19 09:00:00+00', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'SUBMISSION_INTERRUPTED',
   '2026-10-19 08:59:00+00', '2026-10-19 09:10:00+00', '2026-10-19 09:10:00+00', '2026-10-19 09:30:00+00'),
  ('${R3}', ${FORMER_ADMIN}, ${FORMER_ADMIN}, 31, 'UNCERTAIN', 'p3', 'openai', '{"config":{"providerKind":"openai"}}',
   'SUBMITTED', '2026-10-19 07:00:00+00', 'resp_live_3', 'in_progress', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   'DEADLINE_CANCEL_UNCONFIRMED', '2026-10-19 06:59:00+00', '2026-10-19 07:05:00+00', '2026-10-19 07:05:00+00', NULL),
  ('${R4}', ${FORMER_ADMIN}, ${FORMER_ADMIN}, 13, 'SUCCEEDED', 'p4', 'fake', '{"config":{"providerKind":"fake"}}',
   'SUBMITTED', '2026-10-19 06:00:00+00', 'fake_r4', 'completed', 'simulated', 'FOUND', 'OUTCOME: FOUND\nr4', '[]', '[]',
   NULL, 1, NULL, NULL, '2026-10-19 05:59:00+00', '2026-10-19 06:00:05+00', '2026-10-19 06:00:05+00', NULL),
  ('${R5}', ${FORMER_ADMIN}, ${FORMER_ADMIN}, 51, 'QUEUED', 'p5', 'fake',
   '{"config":{"policyVersion":"research-policy-2026-10-18.1","providerKind":"fake","model":"simulated","maxOutputTokens":2000,"maxToolCalls":3,"deadlineSeconds":120,"reasoningEffort":null,"timeZone":"Europe/Kyiv"}}',
   'NOT_SUBMITTED', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   '2026-10-19 05:00:00+00', '2026-10-19 05:00:00+00', NULL, NULL);
INSERT INTO research_reconciliation (id, run_id, operator, resolution, note, evidence) VALUES
  ('00000000-0000-4000-8000-0000000000c2', '${R2}', 'owner', 'PROVIDER_REQUEST_ABSENT', 'checked dashboard', '{"failureCode":"SUBMISSION_INTERRUPTED"}');
INSERT INTO research_tool_item (run_id, response_id, item_key, item_id_reported, item_type, status, action_type) VALUES
  ('${R1}', 'resp_live_1', 'ws_1', true, 'web_search_call', 'completed', 'search'),
  ('${R1}', 'resp_live_1', 'ws_2', true, 'web_search_call', 'completed', 'open_page');
INSERT INTO delivery (id, run_id, kind, chat_id, state, attempts, updated_at) VALUES
  ('${REPORT}', '${R1}', 'REPORT', ${ADMIN}, 'SENT', 1, now()),
  ('${RESEND}', '${R1}', 'RESEND', ${ADMIN}, 'SENT', 1, now()),
  ('${REPORT_R4}', '${R4}', 'REPORT', ${FORMER_ADMIN}, 'SENT', 1, now()),
  ('00000000-0000-4000-8000-0000000000a5', NULL, 'STATUS', ${ADMIN}, 'SENT', 1, now());
INSERT INTO delivery_part (delivery_id, ordinal, html, content_hash, state, telegram_message_id) VALUES
  ('${REPORT}', 0, '<b>Report R1</b>', 'h1', 'SENT', 501),
  ('${RESEND}', 0, '<b>Report R1</b>', 'h1', 'SENT', 502),
  ('${REPORT_R4}', 0, '<b>Report R4</b>', 'h4', 'SENT', 503),
  ('00000000-0000-4000-8000-0000000000a5', 0, 'help', 'h5', 'SENT', 504);
`;

/** Every TRB-020 table, rows as JSON, ordered deterministically. */
const SNAPSHOT_QUERIES = {
  research_run: 'SELECT * FROM research_run ORDER BY id',
  delivery: 'SELECT * FROM delivery ORDER BY id',
  delivery_part: 'SELECT * FROM delivery_part ORDER BY delivery_id, ordinal',
  research_tool_item: 'SELECT * FROM research_tool_item ORDER BY item_key',
  research_reconciliation: 'SELECT * FROM research_reconciliation ORDER BY id',
  telegram_update: 'SELECT * FROM telegram_update ORDER BY update_id',
};

/** Columns added by TRB-030; removed before comparing with pre-migration rows. */
const NEW_COLUMNS = [
  'user_id',
  'invitation_id',
  'reply_markup',
  'suppressed_at',
  'delivery_suppressed_at',
  // TRB-050
  'task_id',
  'task_revision',
  'trigger',
  'admitted_day',
  'admitted_month',
  'delivery_suppression_reason',
  // TRB-060
  'current_attempt_no',
  'next_attempt_at',
  // TRB-070
  'occurrence_at',
  // TRB-080
  'chat_blocked_at',
  'chat_block_reason',
  'file_name',
  'file_content',
  'send_started_at',
  'error_code',
  'seq',
];
/** TRB-080 columns whose names also exist on other tables (delivery.kind is original). */
const NEW_PART_COLUMNS = ['kind'];

async function snapshotTables(client: Client): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const [table, sql] of Object.entries(SNAPSHOT_QUERIES)) {
    const rows = (await client.query<Record<string, unknown>>(sql)).rows;
    result[table] = rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).filter(
          ([column]) =>
            !NEW_COLUMNS.includes(column) &&
            !(table === 'delivery_part' && NEW_PART_COLUMNS.includes(column)),
        ),
      ),
    );
  }
  return result;
}

describe('TRB-030 migration on a database with TRB-020 records', () => {
  const serverUrl = new URL(inject('databaseUrl'));
  const database = disposableDatabaseName();
  const databaseUrl = withDatabase(serverUrl, database);
  let client: Client;
  let before: Record<string, unknown[]>;
  const open: Harness[] = [];

  beforeAll(async () => {
    const admin = new Client({ connectionString: withDatabase(serverUrl, 'postgres') });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    await admin.end();

    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const migrations = readdirSync(MIGRATIONS)
      .filter((name) => /^\d{14}_/.test(name))
      .sort();
    // Everything before TRB-030, then the TRB-020 records, then TRB-030 and later.
    const firstTrb030 = migrations.indexOf(TRB_030);
    expect(firstTrb030).toBeGreaterThan(0);
    for (const name of migrations.slice(0, firstTrb030)) {
      await client.query(readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
    }
    await client.query(TRB_020_RECORDS);
    before = await snapshotTables(client);
    for (const name of migrations.slice(firstTrb030)) {
      await client.query(readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
    }
  });

  afterAll(async () => {
    for (const harness of open.splice(0)) await harness.close();
    await client?.end();
    const admin = new Client({ connectionString: withDatabase(serverUrl, 'postgres') });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  });

  it('keeps every existing record and assigns no owner by itself', async () => {
    expect(await snapshotTables(client)).toEqual(before);
    const owners = await client.query(
      'SELECT count(*)::int AS n FROM research_run WHERE user_id IS NOT NULL',
    );
    expect(owners.rows[0]).toEqual({ n: 0 });
    expect((await client.query('SELECT count(*)::int AS n FROM app_user')).rows[0]).toEqual({
      n: 0,
    });
  });

  it('backfills one attempt per submitted run from its own fields (TRB-060)', async () => {
    const attempts = await client.query(
      `SELECT run_id, attempt_no, submission_state::text, outcome::text, provider_response_id,
              usage, tool_call_count, failure_code, submitted_at, completed_at
         FROM research_attempt ORDER BY run_id`,
    );
    const at = (value: string) => new Date(value);
    expect(attempts.rows).toEqual([
      {
        run_id: R1,
        attempt_no: 1,
        submission_state: 'SUBMITTED',
        outcome: 'PROVIDER_TERMINAL',
        provider_response_id: 'resp_live_1',
        usage: { inputTokens: 23358 },
        tool_call_count: 3,
        failure_code: null,
        submitted_at: at('2026-10-19T10:54:57Z'),
        completed_at: at('2026-10-19T10:55:19Z'),
      },
      expect.objectContaining({
        run_id: R2,
        submission_state: 'SUBMITTING',
        outcome: 'UNCERTAIN',
        provider_response_id: null,
        failure_code: 'SUBMISSION_INTERRUPTED',
      }),
      expect.objectContaining({
        run_id: R3,
        submission_state: 'SUBMITTED',
        outcome: 'UNCERTAIN',
        provider_response_id: 'resp_live_3',
        failure_code: 'DEADLINE_CANCEL_UNCONFIRMED',
      }),
      expect.objectContaining({ run_id: R4, outcome: 'PROVIDER_TERMINAL', usage: null }),
    ]);
    // The queued run never reached submission: no attempt, no invented reservation or event.
    for (const table of ['budget_reservation', 'outbox_event', 'usage_ledger']) {
      expect((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]).toEqual({
        n: 0,
      });
    }
    expect(
      (await client.query('SELECT DISTINCT current_attempt_no FROM research_run')).rows,
    ).toEqual([{ current_attempt_no: 1 }]);
  });

  it('links runs by Telegram identity, fails closed for unknown owners and preserves evidence', async () => {
    const h = await startHarness({ ADMIN_TELEGRAM_IDS: `${ADMIN}` }, { databaseUrl });
    open.push(h);

    // Bootstrap linked the configured administrator's runs only; nothing else changed.
    const owned = await client.query<{ id: string; owner: string | null }>(
      `SELECT r.id, u.telegram_user_id::text AS owner FROM research_run r
         LEFT JOIN app_user u ON u.id = r.user_id ORDER BY r.id`,
    );
    expect(owned.rows).toEqual([
      { id: R1, owner: `${ADMIN}` },
      { id: R2, owner: `${ADMIN}` },
      { id: R3, owner: null },
      { id: R4, owner: null },
      { id: R5, owner: null },
    ]);
    expect(await snapshotTables(client)).toEqual(before);
    await expect(client.query(`UPDATE research_reconciliation SET note = 'x'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(
      client.query(`UPDATE research_run SET user_id = NULL WHERE id = '${R1}'`),
    ).rejects.toThrow(/cannot change/);
    // The unreconciled live run of the former administrator still blocks live work.
    expect(await hasUnresolvedLiveUncertainty(h.prisma)).toBe(true);

    // The queued TRB-020 run (no admission evidence since TRB-050) is never submitted.
    await h.research.tick();
    expect(await h.prisma.researchRun.findUniqueOrThrow({ where: { id: R5 } })).toMatchObject({
      state: 'CANCELLED',
      failureCode: 'ADMISSION_EVIDENCE_MISSING',
      submissionState: 'NOT_SUBMITTED',
    });
    // Historical runs get no invented accounting.
    expect(await h.prisma.budgetReservation.count()).toBe(0);
    expect(await h.prisma.usageLedger.count()).toBe(0);
    expect(
      (
        await h.prisma.researchRun.findMany({
          orderBy: { id: 'asc' },
          select: { admittedDay: true },
        })
      ).map((run) => run.admittedDay),
    ).toEqual(['2026-10-19', '2026-10-19', '2026-10-19', '2026-10-19', '2026-10-19']);
    expect(h.provider.calls.submit).toBe(0);

    // The administrator onboards and can resend the stored TRB-020 report.
    await h.post(privateMessage('/start', ADMIN, 900_001)).expect(200);
    await h.post(callbackQuery(timeZoneCallbackData(0, 'Europe/Kyiv'), ADMIN, 900_002)).expect(200);
    await h.post(privateMessage(`/result ${R1}`, ADMIN, 900_003)).expect(200);
    await h.post(privateMessage(`/result ${R4}`, ADMIN, 900_004)).expect(200);
    await drainDeliveries(h);
    const toAdmin = h.sender.sent.filter((m) => m.chatId === BigInt(ADMIN)).map((m) => m.html);
    expect(toAdmin.slice(-2)).toEqual(['<b>Report R1</b>', 'Запуск не знайдено.']);

    // The former administrator has no account until invited; then their runs are theirs.
    await h.post(privateMessage(`/result ${R4}`, FORMER_ADMIN, 900_005)).expect(200);
    await h.post(privateMessage('/admin invite', ADMIN, 900_006)).expect(200);
    await drainDeliveries(h);
    const token = /\/start ([A-Za-z0-9_-]{43})|\?start=([A-Za-z0-9_-]{43})/.exec(
      h.sender.sent.at(-1)?.html ?? '',
    );
    const value = token?.[1] ?? token?.[2] ?? '';
    await h.post(privateMessage(`/start ${value}`, FORMER_ADMIN, 900_007)).expect(200);
    const member = await h.prisma.appUser.findUniqueOrThrow({
      where: { telegramUserId: BigInt(FORMER_ADMIN) },
    });
    await h
      .post(
        callbackQuery(timeZoneCallbackData(member.revision, 'Europe/Kyiv'), FORMER_ADMIN, 900_008),
      )
      .expect(200);
    await h.post(privateMessage(`/result ${R4}`, FORMER_ADMIN, 900_009)).expect(200);
    await drainDeliveries(h);
    const toFormer = h.sender.sent
      .filter((m) => m.chatId === BigInt(FORMER_ADMIN))
      .map((m) => m.html);
    expect(toFormer[0]).toBe('Цей бот приватний. Доступ лише за запрошенням.');
    expect(toFormer.at(-1)).toBe('<b>Report R4</b>');
    // Nothing was sent about the cancelled legacy run.
    expect(await h.prisma.delivery.findFirst({ where: { runId: R5 } })).toBeNull();
    expect(
      (await h.prisma.researchRun.findMany({ where: { userId: member.id }, select: { id: true } }))
        .map((run) => run.id)
        .sort(),
    ).toEqual([R3, R4, R5]);
    expect(await h.prisma.auditEvent.count({ where: { kind: 'INVITATION_REDEEMED' } })).toBe(1);
    expect(h.provider.calls.submit).toBe(0);
  });
});

describe('TRB-030 durable-suppression migration on a database with suspended users', () => {
  const serverUrl = new URL(inject('databaseUrl'));
  const database = disposableDatabaseName();
  const databaseUrl = withDatabase(serverUrl, database);
  let client: Client;

  beforeAll(async () => {
    const admin = new Client({ connectionString: withDatabase(serverUrl, 'postgres') });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    await admin.end();
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const migrations = readdirSync(MIGRATIONS)
      .filter((name) => /^\d{14}_/.test(name))
      .sort();
    const suppression = migrations.findIndex((name) =>
      name.endsWith('_trb_030_durable_suppression'),
    );
    expect(suppression).toBeGreaterThan(migrations.indexOf(TRB_030));
    for (const name of migrations.slice(0, suppression)) {
      await client.query(readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
    }
    // A suspended member with a running run (one delivery being sent) and an
    // already-suppressed delivery; an active member with a queued run.
    await client.query(`
      INSERT INTO app_user (id, telegram_user_id, private_chat_id, role, status, onboarding_state, time_zone,
                            invited_at, onboarded_at, suspended_at, updated_at) VALUES
        ('00000000-0000-4000-8000-0000000000b1', 3003, 3003, 'MEMBER', 'SUSPENDED', 'COMPLETED', 'Europe/Kyiv',
         now(), now(), now(), now()),
        ('00000000-0000-4000-8000-0000000000b2', 3004, 3004, 'MEMBER', 'ACTIVE', 'COMPLETED', 'Europe/Kyiv',
         now(), now(), NULL, now());
      INSERT INTO research_run (id, user_id, requested_by_telegram_user_id, chat_id, source_update_id, state, prompt,
                                provider_kind, request_snapshot, updated_at) VALUES
        ('${R1}', '00000000-0000-4000-8000-0000000000b1', 3003, 3003, 1, 'RUNNING', 'p', 'fake', '{}', now()),
        ('${R2}', '00000000-0000-4000-8000-0000000000b2', 3004, 3004, 2, 'QUEUED', 'p', 'fake', '{}', now());
      INSERT INTO delivery (id, run_id, kind, chat_id, state, last_error_code, updated_at) VALUES
        ('${REPORT}', '${R1}', 'STATUS', 3003, 'SENDING', NULL, now()),
        ('${RESEND}', '${R1}', 'STATUS', 3003, 'SUPPRESSED', 'RECIPIENT_SUSPENDED', now()),
        ('${REPORT_R4}', '${R2}', 'STATUS', 3004, 'SENDING', NULL, now());
    `);
    for (const name of migrations.slice(suppression)) {
      await client.query(readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
    }
  });

  afterAll(async () => {
    await client?.end();
    const admin = new Client({ connectionString: withDatabase(serverUrl, 'postgres') });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  });

  it('records the decision for currently suspended users only, without changing states', async () => {
    const runs = await client.query(
      'SELECT id, state, delivery_suppressed_at IS NOT NULL AS decided FROM research_run ORDER BY id',
    );
    expect(runs.rows).toEqual([
      { id: R1, state: 'RUNNING', decided: true },
      { id: R2, state: 'QUEUED', decided: false },
    ]);
    const deliveries = await client.query(
      'SELECT id, state, suppressed_at IS NOT NULL AS decided FROM delivery ORDER BY id',
    );
    expect(deliveries.rows).toEqual([
      { id: REPORT, state: 'SENDING', decided: true },
      { id: RESEND, state: 'SUPPRESSED', decided: true },
      { id: REPORT_R4, state: 'SENDING', decided: false },
    ]);
    await expect(
      client.query(`UPDATE delivery SET suppressed_at = NULL WHERE id = '${RESEND}'`),
    ).rejects.toThrow(/delivery_suppressed_has_decision/);
  });
});

import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { CLOCK, type Clock } from '../common/clock';
import { errorInfo } from '../common/error-info';
import { WorkerLoop } from '../common/worker-loop';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import type { Tx } from '../database/prisma-errors';
import { PrismaService } from '../database/prisma.service';
import { cancelDeliveryEvents, wakeNextInChat } from '../delivery/delivery-records';
import { lockTelegramIdentity, lockUserByTelegramId } from '../identity/users';

const DAY_MS = 86_400_000;
const SHUTDOWN_WAIT_MS = 10_000;
/** Placeholder for redacted user text where a column must stay non-empty. */
export const REDACTED = '[deleted]';
/** Code of a waiting delivery whose content expired before it could be sent. */
export const CONTENT_EXPIRED = 'CONTENT_EXPIRED';

export type RunPurge = 'PURGED' | 'NOT_ELIGIBLE' | 'BUSY';

export interface RetentionPass {
  runs: number;
  runsBusy: number;
  deliveries: number;
  tasks: number;
  drafts: number;
  invitations: number;
  updates: number;
  events: number;
}

/**
 * Retention cleanup (TRB-090, docs/RETENTION.md).
 *
 * Off by default (RETENTION_CLEANUP=off); runs with BACKGROUND_WORKERS=on when
 * enabled. Every pass is bounded (RETENTION_BATCH_SIZE per category) and uses
 * the injected clock for cutoffs. Each item is handled in its own transaction,
 * rechecked under row locks with a conditional update, so passes are
 * idempotent, restart-safe and safe with several instances (SKIP LOCKED
 * candidates, re-validation, "not yet purged" conditions).
 *
 * Content (prompts, request text, reports, citations, sources, delivery
 * payloads, documents, resend copies, deleted tasks' names and prompts,
 * expired drafts, invitation hashes) is removed after REPORT_RETENTION_DAYS
 * from its terminal time. Inbox and queue bookkeeping is deleted after
 * METADATA_RETENTION_DAYS. Accounting evidence (runs' metadata, attempts,
 * reservations, ledger, reconciliations, pricing) and audit events are never
 * deleted here, so exposure (and with it every budget check) is unaffected.
 *
 * Lock order is the established one: owner identity lock, user row, then
 * task, run, delivery and reservation rows.
 */
@Injectable()
export class RetentionService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private loop: WorkerLoop | undefined;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: Env,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.BACKGROUND_WORKERS !== 'on' || this.config.RETENTION_CLEANUP !== 'on') return;
    this.loop = new WorkerLoop(
      'Retention cleanup',
      this.config.RETENTION_INTERVAL_SECONDS * 1_000,
      () => this.tick(),
      this.logger,
    );
    this.loop.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.loop?.stop(SHUTDOWN_WAIT_MS);
  }

  /** One pass; true when a category filled its batch (the loop continues at once). */
  async tick(): Promise<boolean> {
    const pass = await this.runPass();
    const total = (Object.values(pass) as number[]).reduce((a, b) => a + b, 0);
    if (total > 0) this.logger.log({ message: 'Retention pass', ...pass });
    const batch = this.config.RETENTION_BATCH_SIZE;
    return [pass.runs, pass.deliveries, pass.tasks, pass.drafts, pass.invitations].some(
      (count) => count >= batch,
    );
  }

  async runPass(): Promise<RetentionPass> {
    const now = this.clock.now();
    const contentCutoff = new Date(now.getTime() - this.config.REPORT_RETENTION_DAYS * DAY_MS);
    const metadataCutoff = new Date(now.getTime() - this.config.METADATA_RETENTION_DAYS * DAY_MS);
    const pass: RetentionPass = {
      runs: 0,
      runsBusy: 0,
      deliveries: 0,
      tasks: 0,
      drafts: 0,
      invitations: 0,
      updates: 0,
      events: 0,
    };
    for (const candidate of await this.runCandidates(contentCutoff)) {
      try {
        const result = await this.purgeRun(candidate.id, candidate.telegramUserId, contentCutoff);
        if (result === 'PURGED') pass.runs += 1;
        if (result === 'BUSY') pass.runsBusy += 1;
      } catch (error) {
        this.logger.error({
          message: 'Run purge failed',
          runId: candidate.id,
          ...errorInfo(error),
        });
      }
    }
    pass.deliveries = await this.purgeStandaloneDeliveries(contentCutoff);
    pass.tasks = await this.purgeDeletedTasks(contentCutoff);
    pass.drafts = await this.deleteExpiredDrafts(now);
    pass.invitations = await this.clearInvitationHashes(now);
    pass.updates = await this.deleteOldUpdates(metadataCutoff);
    pass.events = await this.deleteOldEvents(metadataCutoff);
    return pass;
  }

  private runCandidates(cutoff: Date) {
    return this.prisma.$queryRaw<{ id: string; telegramUserId: bigint | null }[]>`
      SELECT r.id, u.telegram_user_id AS "telegramUserId"
        FROM research_run r LEFT JOIN app_user u ON u.id = r.user_id
       WHERE r.content_purged_at IS NULL
         AND r.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN')
         AND COALESCE(r.completed_at, r.updated_at) < ${cutoff}
       ORDER BY COALESCE(r.completed_at, r.updated_at), r.id
       LIMIT ${this.config.RETENTION_BATCH_SIZE}`;
  }

  /**
   * Removes one finished run's content and every copy of it: the report and
   * resend parts (messages and documents) and the run's status messages. Kept:
   * outcome, warnings (codes), usage, response IDs, attempts, reservations,
   * ledger, reconciliation, delivery states and Telegram message IDs.
   * Not eligible while accounting is unresolved (an UNRESOLVED reservation) or
   * a live UNCERTAIN run awaits provider reconciliation. BUSY while one of its
   * deliveries is being sent (retried next pass). A waiting delivery of the
   * run is finalized SUPPRESSED / CONTENT_EXPIRED first, and the next delivery
   * to its chat is woken, so nothing is left blocking the chat.
   * The age reference is the run's completion; resends never extend it.
   */
  async purgeRun(runId: string, ownerTelegramId: bigint | null, cutoff: Date): Promise<RunPurge> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      if (ownerTelegramId !== null) {
        await lockTelegramIdentity(tx, ownerTelegramId);
        await lockUserByTelegramId(tx, ownerTelegramId);
      }
      const rows = await tx.$queryRaw<
        { state: string; reconciledAt: Date | null; providerKind: string; eligible: boolean }[]
      >`
        SELECT state::text AS state, reconciled_at AS "reconciledAt", provider_kind AS "providerKind",
               (content_purged_at IS NULL AND COALESCE(completed_at, updated_at) < ${cutoff}
                AND state IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN')) AS eligible
          FROM research_run WHERE id = ${runId}::uuid FOR UPDATE`;
      const run = rows[0];
      if (!run?.eligible) return { result: 'NOT_ELIGIBLE' as const, chats: [] };
      if (run.state === 'UNCERTAIN' && run.providerKind !== 'fake' && run.reconciledAt === null) {
        return { result: 'NOT_ELIGIBLE' as const, chats: [] };
      }
      const deliveries = await tx.$queryRaw<{ id: string; state: string; chatId: bigint }[]>`
        SELECT id, state::text AS state, chat_id AS "chatId" FROM delivery
         WHERE run_id = ${runId}::uuid ORDER BY seq FOR UPDATE`;
      if (deliveries.some((delivery) => delivery.state === 'SENDING')) {
        return { result: 'BUSY' as const, chats: [] };
      }
      const reservations = await tx.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM budget_reservation
         WHERE run_id = ${runId}::uuid FOR SHARE`;
      if (reservations.some((row) => row.status === 'UNRESOLVED' || row.status === 'RESERVED')) {
        return { result: 'NOT_ELIGIBLE' as const, chats: [] };
      }
      const chats = new Set<bigint>();
      for (const delivery of deliveries) {
        if (delivery.state !== 'PENDING' && delivery.state !== 'RETRYABLE_FAILURE') continue;
        await tx.$executeRaw`
          UPDATE delivery SET state = 'SUPPRESSED', suppressed_at = COALESCE(suppressed_at, now()),
                 last_error_code = ${CONTENT_EXPIRED}, lease_owner = NULL, lease_until = NULL,
                 updated_at = now()
           WHERE id = ${delivery.id}::uuid`;
        await cancelDeliveryEvents(tx, delivery.id);
        chats.add(delivery.chatId);
      }
      await purgeParts(
        tx,
        deliveries.map((delivery) => delivery.id),
      );
      await tx.$executeRaw`
        UPDATE research_run
           SET prompt = ${REDACTED}, report_text = NULL, citations = NULL, sources = NULL,
               request_snapshot = request_snapshot - 'request',
               content_purged_at = now()
         WHERE id = ${runId}::uuid AND content_purged_at IS NULL`;
      for (const chatId of chats) await wakeNextInChat(tx, chatId);
      return { result: 'PURGED' as const, chats: [...chats] };
    });
    return outcome.result;
  }

  /** Payloads of finished deliveries that belong to no run (replies, cards, views, invitations). */
  private async purgeStandaloneDeliveries(cutoff: Date): Promise<number> {
    let count = 0;
    const candidates = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT d.id FROM delivery d
       WHERE d.run_id IS NULL AND d.state IN ('SENT', 'UNKNOWN', 'PERMANENT_FAILURE', 'SUPPRESSED')
         AND d.updated_at < ${cutoff}
         AND EXISTS (SELECT 1 FROM delivery_part p WHERE p.delivery_id = d.id AND p.content_purged_at IS NULL)
       ORDER BY d.updated_at, d.id
       LIMIT ${this.config.RETENTION_BATCH_SIZE}`;
    for (const { id } of candidates) {
      const purged = await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM delivery
           WHERE id = ${id}::uuid AND state IN ('SENT', 'UNKNOWN', 'PERMANENT_FAILURE', 'SUPPRESSED')
             AND updated_at < ${cutoff}
             FOR UPDATE SKIP LOCKED`;
        if (locked.length === 0) return 0;
        return purgeParts(tx, [id]);
      });
      if (purged > 0) count += 1;
    }
    return count;
  }

  /** Name and prompt of tasks deleted before the cutoff, and edit drafts that still copy them. */
  private async purgeDeletedTasks(cutoff: Date): Promise<number> {
    const candidates = await this.prisma.$queryRaw<{ id: string; telegramUserId: bigint }[]>`
      SELECT t.id, u.telegram_user_id AS "telegramUserId"
        FROM task t JOIN app_user u ON u.id = t.user_id
       WHERE t.state = 'DELETED' AND t.content_purged_at IS NULL AND t.deleted_at < ${cutoff}
       ORDER BY t.deleted_at, t.id
       LIMIT ${this.config.RETENTION_BATCH_SIZE}`;
    let count = 0;
    for (const candidate of candidates) {
      count += await this.prisma.$transaction(async (tx) => {
        await lockTelegramIdentity(tx, candidate.telegramUserId);
        await lockUserByTelegramId(tx, candidate.telegramUserId);
        await tx.$executeRaw`DELETE FROM task_draft WHERE task_id = ${candidate.id}::uuid`;
        return tx.$executeRaw`
          UPDATE task SET name = ${REDACTED}, prompt = ${REDACTED}, content_purged_at = now(),
                 updated_at = now()
           WHERE id = ${candidate.id}::uuid AND state = 'DELETED' AND content_purged_at IS NULL
             AND deleted_at < ${cutoff}`;
      });
    }
    return count;
  }

  /** Expired drafts carry entered names and prompts; the user is told at the next interaction anyway. */
  private deleteExpiredDrafts(now: Date): Promise<number> {
    return this.prisma.$executeRaw`
      DELETE FROM task_draft
       WHERE id IN (SELECT id FROM task_draft WHERE expires_at < ${now}
                     ORDER BY expires_at LIMIT ${this.config.RETENTION_BATCH_SIZE}
                       FOR UPDATE SKIP LOCKED)`;
  }

  /**
   * Invitations are kept (audit events reference them) but a redeemed, revoked
   * or expired one no longer needs its token hash: it is replaced by a value no
   * token can hash to.
   */
  private clearInvitationHashes(now: Date): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE invitation SET token_hash = 'cleared:' || id::text
       WHERE id IN (SELECT id FROM invitation
                     WHERE token_hash NOT LIKE 'cleared:%'
                       AND (redeemed_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at < ${now})
                     LIMIT ${this.config.RETENTION_BATCH_SIZE}
                       FOR UPDATE SKIP LOCKED)`;
  }

  /**
   * Inbox records older than the metadata period, except a user's verified
   * private updates while a recorded destination refusal of that user's chat is
   * still pending (they decide whether it is superseded). Replayed research
   * updates stay harmless after deletion: a run keeps its unique source update.
   */
  private deleteOldUpdates(cutoff: Date): Promise<number> {
    return this.prisma.$executeRaw`
      DELETE FROM telegram_update
       WHERE update_id IN (
         SELECT tu.update_id FROM telegram_update tu
          WHERE tu.received_at < ${cutoff}
            AND NOT EXISTS (
              SELECT 1 FROM delivery d JOIN app_user u
                ON d.chat_id = u.private_chat_id OR d.chat_id = u.telegram_user_id
               WHERE u.telegram_user_id = tu.sender_telegram_id
                 AND d.destination_block_reason IS NOT NULL AND d.destination_block_applied_at IS NULL)
          ORDER BY tu.received_at
          LIMIT ${this.config.RETENTION_BATCH_SIZE * 10})`;
  }

  /** Published or cancelled queue bookkeeping of finished work, and schedule history. */
  private async deleteOldEvents(cutoff: Date): Promise<number> {
    const batch = this.config.RETENTION_BATCH_SIZE * 10;
    const outbox = await this.prisma.$executeRaw`
      DELETE FROM outbox_event WHERE id IN (
        SELECT o.id FROM outbox_event o JOIN research_run r ON r.id = o.run_id
         WHERE COALESCE(o.dispatched_at, o.cancelled_at) < ${cutoff}
           AND r.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN')
         LIMIT ${batch})`;
    const deliveryEvents = await this.prisma.$executeRaw`
      DELETE FROM delivery_event WHERE id IN (
        SELECT e.id FROM delivery_event e JOIN delivery d ON d.id = e.delivery_id
         WHERE COALESCE(e.dispatched_at, e.cancelled_at) < ${cutoff}
           AND d.state IN ('SENT', 'UNKNOWN', 'PERMANENT_FAILURE', 'SUPPRESSED')
         LIMIT ${batch})`;
    const schedule = await this.prisma.$executeRaw`
      DELETE FROM schedule_event WHERE id IN (
        SELECT id FROM schedule_event WHERE created_at < ${cutoff} LIMIT ${batch})`;
    return outbox + deliveryEvents + schedule;
  }
}

/**
 * The narrow purge path of immutable delivery parts (the trigger allows only
 * this change, once): payload emptied, content_purged_at set. Hash, file name,
 * state and Telegram message ID stay. Never applied to a part in flight.
 */
async function purgeParts(tx: Tx, deliveryIds: readonly string[]): Promise<number> {
  if (deliveryIds.length === 0) return 0;
  return tx.$executeRaw`
    UPDATE delivery_part
       SET html = '', reply_markup = NULL, file_content = NULL, content_purged_at = now()
     WHERE delivery_id = ANY(${deliveryIds}::uuid[]) AND content_purged_at IS NULL
       AND state <> 'SENDING'`;
}

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
import { createStatusDelivery } from '../delivery/delivery-records';
import type { ScheduleDisposition, Task } from '../generated/prisma/client';
import { accountAccess } from '../identity/authorization';
import { lockTelegramIdentity, lockUserByTelegramId } from '../identity/users';
import { admitResearch } from '../research/admission';
import {
  formatInZone,
  latestOccurrenceAtOrBefore,
  nextOccurrenceAfter,
  occurrencesBetween,
  type Schedule,
} from './recurrence';

/** Tasks handled per scheduler pass; each in its own transaction. */
export const SCHEDULER_BATCH = 20;
/** SPEC §4: at most one catch-up, for an occurrence no older than this. */
export const CATCH_UP_WINDOW_MS = 24 * 3_600_000;
/** An occurrence admitted later than this after its planned time counts as a catch-up. */
export const ON_TIME_GRACE_MS = 5 * 60_000;
const SHUTDOWN_WAIT_MS = 10_000;

export type OccurrenceResult = ScheduleDisposition | 'STALE';

interface Candidate {
  id: string;
  revision: number;
  nextRunAt: Date;
  telegramUserId: bigint;
}

export const scheduleOfTask = (
  task: Pick<Task, 'scheduleKind' | 'weekday' | 'localTime' | 'timeZone'>,
): Schedule => ({
  scheduleKind: task.scheduleKind,
  weekday: task.weekday,
  localTime: task.localTime,
  timeZone: task.timeZone,
});

/**
 * Persistent scheduler (TRB-070, docs/SCHEDULING.md).
 *
 * Each pass first initializes active scheduled tasks that have no next
 * occurrence yet (tasks from before scheduling existed) to their next future
 * occurrence, without admitting anything. It then takes a bounded batch of
 * due tasks. Each is handled in one transaction, under the owner's identity
 * lock and user row lock and then the task row lock: the same order as the
 * inbox, admission and suspension. The task is revalidated under the locks
 * (state, revision and the due occurrence it was selected for), so a stale
 * candidate, or a second scheduler that lost the race, does nothing.
 *
 * In that transaction:
 * - only the latest due occurrence is considered. Earlier missed ones become
 *   one SKIPPED_MISSED range record;
 * - the latest is admitted through the normal admission path (quiet) when it
 *   is no older than 24 hours, otherwise skipped;
 * - the outcome becomes its disposition (ADMITTED, SKIPPED_OVERLAP,
 *   SKIPPED_DENIED with the reason, SKIPPED_MISSED);
 * - next_run_at advances to the first occurrence after now.
 *
 * Every denial thus advances the schedule once (no retry on every tick), and
 * a rolled-back transaction leaves the occurrence due. The unique keys on
 * (task, occurrence) for events and scheduled runs back this up. The
 * scheduler never calls the provider: admitted work goes through the outbox
 * and pg-boss like any other run.
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private loop: WorkerLoop | undefined;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: Env,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Runs with BACKGROUND_WORKERS=on and research enabled (fake or live), like the
   * research worker. While research is disabled nothing is recorded; when it is
   * enabled again the catch-up rule applies to what was missed.
   */
  onApplicationBootstrap(): void {
    if (this.config.BACKGROUND_WORKERS !== 'on' || this.config.RESEARCH_MODE === 'disabled') return;
    this.loop = new WorkerLoop(
      'Scheduler',
      this.config.SCHEDULER_POLL_INTERVAL_SECONDS * 1_000,
      () => this.tick(),
      this.logger,
    );
    this.loop.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.loop?.stop(SHUTDOWN_WAIT_MS);
  }

  /** One pass. Returns true when a full batch made progress (the loop then continues at once). */
  async tick(): Promise<boolean> {
    const now = this.clock.now();
    const initialized = await this.initializeMissing(now);
    const due = await this.prisma.$queryRaw<Candidate[]>`
      SELECT t.id, t.revision, t.next_run_at AS "nextRunAt", u.telegram_user_id AS "telegramUserId"
        FROM task t JOIN app_user u ON u.id = t.user_id
       WHERE t.state = 'ACTIVE' AND t.next_run_at IS NOT NULL AND t.next_run_at <= ${now}
       ORDER BY t.next_run_at, t.id
       LIMIT ${SCHEDULER_BATCH}`;
    let progressed = 0;
    for (const candidate of due) {
      try {
        if ((await this.processOccurrence(candidate, now)) !== 'STALE') progressed += 1;
      } catch (error) {
        // Rolled back: the occurrence stays due and is retried on a later pass.
        this.logger.error({
          message: 'Scheduled occurrence failed',
          taskId: candidate.id,
          ...errorInfo(error),
        });
      }
    }
    return (due.length === SCHEDULER_BATCH && progressed > 0) || initialized === SCHEDULER_BATCH;
  }

  /**
   * Existing-task initialization policy: an active daily/weekly task without a
   * next occurrence gets the first occurrence after now. Nothing before that is
   * executed or recorded. A conditional single-row update: a concurrent edit
   * (revision) or another scheduler wins without conflict.
   */
  private async initializeMissing(now: Date): Promise<number> {
    const tasks = await this.prisma.task.findMany({
      where: { state: 'ACTIVE', scheduleKind: { not: 'MANUAL' }, nextRunAt: null },
      orderBy: { createdAt: 'asc' },
      take: SCHEDULER_BATCH,
    });
    let count = 0;
    for (const task of tasks) {
      const next = nextOccurrenceAfter(scheduleOfTask(task), now);
      const updated = await this.prisma.task.updateMany({
        where: { id: task.id, revision: task.revision, state: 'ACTIVE', nextRunAt: null },
        data: { nextRunAt: next },
      });
      count += updated.count;
    }
    if (count > 0) this.logger.log({ message: 'Initialized task schedules', count });
    return count;
  }

  /** Handles the due occurrence of one task; see the class comment. */
  async processOccurrence(candidate: Candidate, now: Date): Promise<OccurrenceResult> {
    const result = await this.prisma.$transaction(async (tx) => {
      await lockTelegramIdentity(tx, candidate.telegramUserId);
      const user = await lockUserByTelegramId(tx, candidate.telegramUserId);
      await tx.$queryRaw`SELECT 1 AS locked FROM task WHERE id = ${candidate.id}::uuid FOR UPDATE`;
      const task = await tx.task.findUnique({ where: { id: candidate.id } });
      if (
        !user ||
        !task ||
        task.userId !== user.id ||
        task.state !== 'ACTIVE' ||
        task.scheduleKind === 'MANUAL' ||
        task.revision !== candidate.revision ||
        task.nextRunAt?.getTime() !== candidate.nextRunAt.getTime() ||
        task.nextRunAt.getTime() > now.getTime()
      ) {
        return 'STALE' as const;
      }
      const schedule = scheduleOfTask(task);
      const due = task.nextRunAt;
      const latestCandidate = latestOccurrenceAtOrBefore(schedule, now) ?? due;
      const latest = latestCandidate.getTime() < due.getTime() ? due : latestCandidate;
      const record = (input: {
        occurrenceAt: Date;
        disposition: ScheduleDisposition;
        reason: string;
        runId?: string;
        rangeEnd?: Date | null;
        skippedCount?: number | null;
        notified?: boolean;
      }) =>
        tx.scheduleEvent.create({
          data: {
            taskId: task.id,
            userId: user.id,
            taskRevision: task.revision,
            occurrenceAt: input.occurrenceAt,
            disposition: input.disposition,
            reason: input.reason,
            runId: input.runId ?? null,
            rangeEnd: input.rangeEnd ?? null,
            skippedCount: input.skippedCount ?? null,
            notified: input.notified ?? false,
            latenessSeconds: Math.max(
              0,
              Math.floor((now.getTime() - input.occurrenceAt.getTime()) / 1_000),
            ),
            catchUp:
              input.disposition === 'ADMITTED' &&
              now.getTime() - input.occurrenceAt.getTime() > ON_TIME_GRACE_MS,
          },
        });

      // Earlier missed occurrences: one range record, never admitted.
      if (latest.getTime() > due.getTime()) {
        const missed = occurrencesBetween(schedule, due, latest);
        await record({
          occurrenceAt: due,
          disposition: 'SKIPPED_MISSED',
          reason: 'SUPERSEDED_BY_LATER_OCCURRENCE',
          rangeEnd: missed.last,
          skippedCount: missed.count,
        });
      }

      let disposition: ScheduleDisposition;
      if (now.getTime() - latest.getTime() > CATCH_UP_WINDOW_MS) {
        disposition = 'SKIPPED_MISSED';
        await record({ occurrenceAt: latest, disposition, reason: 'CATCH_UP_WINDOW_EXCEEDED' });
      } else if (user.privateChatId === null) {
        disposition = 'SKIPPED_DENIED';
        await record({ occurrenceAt: latest, disposition, reason: 'NO_PRIVATE_CHAT' });
      } else if (user.chatBlockedAt) {
        // Defence in depth: a confirmed block pauses the tasks (TRB-080), so this is not expected.
        disposition = 'SKIPPED_DENIED';
        await record({ occurrenceAt: latest, disposition, reason: 'CHAT_BLOCKED' });
      } else {
        const outcome = await admitResearch(tx, this.config, {
          user,
          chatId: user.privateChatId,
          updateId: null,
          now,
          source: {
            kind: 'schedule',
            taskId: task.id,
            revision: task.revision,
            occurrenceAt: latest,
          },
          quiet: true,
        });
        if (outcome.disposition === 'RUN_ACCEPTED' && outcome.runId) {
          disposition = 'ADMITTED';
          await record({
            occurrenceAt: latest,
            disposition,
            reason: 'ADMITTED',
            runId: outcome.runId,
          });
        } else if (outcome.reason === 'TASK_RUN_ACTIVE') {
          // The active run is referenced, not reused as this occurrence; nothing is deferred.
          disposition = 'SKIPPED_OVERLAP';
          await record({
            occurrenceAt: latest,
            disposition,
            reason: 'TASK_RUN_ACTIVE',
            ...(outcome.runId ? { runId: outcome.runId } : {}),
          });
        } else {
          disposition = 'SKIPPED_DENIED';
          const reason = outcome.reason ?? 'ADMISSION_REFUSED';
          const notified = await this.notifyDenial(tx, task, user, latest, reason, outcome.message);
          await record({ occurrenceAt: latest, disposition, reason, notified });
        }
      }

      const next = nextOccurrenceAfter(schedule, now);
      const advanced = await tx.task.updateMany({
        where: { id: task.id, revision: task.revision, nextRunAt: due, state: 'ACTIVE' },
        data: { nextRunAt: next },
      });
      if (advanced.count !== 1) throw new Error('scheduled task changed under its lock');
      return disposition;
    });
    if (result !== 'STALE') {
      this.logger.log({
        message: 'Scheduled occurrence',
        taskId: candidate.id,
        disposition: result,
      });
    }
    return result;
  }

  /**
   * A refused occurrence is reported to the owner once per consecutive reason:
   * repeated denials for the same reason stay silent until something else
   * happened in between. Nothing is sent to users without access.
   */
  private async notifyDenial(
    tx: Tx,
    task: Task,
    user: { privateChatId: bigint | null } & Parameters<typeof accountAccess>[0],
    occurrenceAt: Date,
    reason: string,
    message: string | undefined,
  ): Promise<boolean> {
    if (!message || user.privateChatId === null) return false;
    const access = accountAccess(user, this.config);
    if (access === 'SUSPENDED' || access === 'NONE') return false;
    // Missed-occurrence records are never reported, so they do not count as "something else".
    const previous = await tx.scheduleEvent.findFirst({
      where: { taskId: task.id, disposition: { not: 'SKIPPED_MISSED' } },
      orderBy: { occurrenceAt: 'desc' },
      select: { disposition: true, reason: true },
    });
    if (previous?.disposition === 'SKIPPED_DENIED' && previous.reason === reason) return false;
    await createStatusDelivery(
      tx,
      user.privateChatId,
      `Заплановане дослідження «${task.name}» на ${formatInZone(occurrenceAt, task.timeZone)} ` +
        `(${task.timeZone}) не запущено: ${message} Наступний запуск — за розкладом; ` +
        'про ту саму причину повторно не повідомлятимемо.',
    );
    return true;
  }
}

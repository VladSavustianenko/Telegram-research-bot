import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppLifecycle } from '../common/lifecycle';
import { PrismaService } from '../database/prisma.service';
import { ExecutionGate } from '../operations/execution-gate';
import { QueueService } from '../queue/queue.service';

export type CheckStatus = 'up' | 'down';

export interface ReadinessReport {
  /** `held`: healthy but deliberately not executing (operational hold, TRB-100). */
  status: 'ok' | 'held' | 'error';
  checks: {
    config: CheckStatus;
    database: CheckStatus;
    queue: CheckStatus | 'disabled';
    /** Every migration of this build is applied and none failed (TRB-100). */
    schema: CheckStatus;
    /** Background components this configuration requires are running and not stalled. */
    workers: CheckStatus | 'disabled';
    execution: 'open' | 'held' | 'pending';
  };
}

/** Maximum time a readiness response waits for the database probe. */
export const READINESS_TIMEOUT_MS = Symbol('READINESS_TIMEOUT_MS');
export const DEFAULT_READINESS_TIMEOUT_MS = 2_000;

/**
 * Readiness checks. Never calls paid external APIs (OpenAI, Telegram).
 * `queue` (TRB-060) is the in-process state of the pg-boss queue, with no
 * extra query: "disabled" without a research provider (always ready), "up"
 * once started, "down" while starting, retrying or stopped (not ready).
 *
 * TRB-100: `schema` and `execution` come from the execution gate (no extra
 * query): a missing or failed migration is "down"; an operational hold is
 * reported as status "held" with HTTP 200, so a quarantined deployment stays
 * observable without executing anything. `workers` is "down" when a
 * component the configuration requires has not started, failed, stalled, or
 * stopped because shutdown began; component names are logged, not returned.
 *
 * At most one database probe is in flight: concurrent and repeated requests
 * share it, so a stalled database cannot accumulate probes. The probe itself is
 * bounded by the database pool timeouts (see createPool); the readiness
 * deadline only bounds how long a response waits for it.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private inFlightProbe: Promise<CheckStatus> | undefined;
  private lastDown = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly gate: ExecutionGate,
    private readonly lifecycle: AppLifecycle,
    @Inject(READINESS_TIMEOUT_MS) private readonly timeoutMs: number,
  ) {}

  async readiness(): Promise<ReadinessReport> {
    const database = await this.checkDatabase();
    const status = this.queueService.status;
    const queue = status === 'disabled' ? 'disabled' : status === 'up' ? 'up' : 'down';
    const gate = this.gate.state;
    const schema: CheckStatus = gate === 'open' || gate === 'held' ? 'up' : 'down';
    const execution = gate === 'open' ? 'open' : gate === 'held' ? 'held' : 'pending';
    const components = this.lifecycle.report();
    const workers = components.registered === 0 ? 'disabled' : components.healthy ? 'up' : 'down';
    // Configuration is validated before the application starts, so a running process has valid config.
    const checks = { config: 'up', database, queue, schema, workers, execution } as const;
    const infrastructure = database === 'up' && queue !== 'down' && schema === 'up';
    let result: ReadinessReport['status'] = 'error';
    if (infrastructure && !this.lifecycle.shuttingDown) {
      if (execution === 'held') result = 'held';
      else if (workers !== 'down') result = 'ok';
    }
    const down = components.down.join(',');
    if (down !== this.lastDown && !this.lifecycle.shuttingDown) {
      this.lastDown = down;
      if (down) this.logger.warn({ message: 'Readiness: components not up', components: down });
    }
    return { status: result, checks };
  }

  private async checkDatabase(): Promise<CheckStatus> {
    this.inFlightProbe ??= this.probeDatabase().finally(() => {
      this.inFlightProbe = undefined;
    });
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.timeoutMs);
    });
    const result = await Promise.race([this.inFlightProbe, deadline]);
    clearTimeout(timer);
    if (result === 'timeout') {
      this.logger.warn({ message: 'Database readiness check exceeded deadline' });
      return 'down';
    }
    return result;
  }

  private async probeDatabase(): Promise<CheckStatus> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'up';
    } catch (error) {
      // Log only the error class/code; connection errors can contain connection details.
      const code = (error as { code?: unknown }).code;
      this.logger.warn({
        message: 'Database readiness check failed',
        errorName: (error as Error).name,
        code,
      });
      return 'down';
    }
  }
}

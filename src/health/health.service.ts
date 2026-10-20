import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { QueueService } from '../queue/queue.service';

export type CheckStatus = 'up' | 'down';

export interface ReadinessReport {
  status: 'ok' | 'error';
  checks: { config: CheckStatus; database: CheckStatus; queue: CheckStatus | 'disabled' };
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
 * At most one database probe is in flight: concurrent and repeated requests
 * share it, so a stalled database cannot accumulate probes. The probe itself is
 * bounded by the database pool timeouts (see createPool); the readiness
 * deadline only bounds how long a response waits for it.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private inFlightProbe: Promise<CheckStatus> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    @Inject(READINESS_TIMEOUT_MS) private readonly timeoutMs: number,
  ) {}

  async readiness(): Promise<ReadinessReport> {
    const database = await this.checkDatabase();
    const status = this.queueService.status;
    const queue = status === 'disabled' ? 'disabled' : status === 'up' ? 'up' : 'down';
    // Configuration is validated before the application starts, so a running process has valid config.
    const checks = { config: 'up', database, queue } as const;
    return { status: database === 'up' && queue !== 'down' ? 'ok' : 'error', checks };
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

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

export type CheckStatus = 'up' | 'down';

export interface ReadinessReport {
  status: 'ok' | 'error';
  checks: { config: CheckStatus; database: CheckStatus };
}

const DATABASE_CHECK_TIMEOUT_MS = 2_000;

/**
 * Readiness checks. Never calls paid external APIs (OpenAI, Telegram).
 * Worker readiness is added when workers exist (TRB-060).
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  async readiness(): Promise<ReadinessReport> {
    const database = await this.checkDatabase();
    // Configuration is validated before the application starts, so a running process has valid config.
    const checks = { config: 'up', database } as const;
    return { status: database === 'up' ? 'ok' : 'error', checks };
  }

  private async checkDatabase(): Promise<CheckStatus> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), DATABASE_CHECK_TIMEOUT_MS);
        }),
      ]);
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
    } finally {
      clearTimeout(timer);
    }
  }
}

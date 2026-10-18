import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { APP_CONFIG } from '../config/config.module';
import { Env } from '../config/env.schema';
import { PrismaClient } from '../generated/prisma/client';

/** Client-side backstop beyond the server-side statement timeout. */
const QUERY_TIMEOUT_MARGIN_MS = 5_000;

type DatabaseConfig = Pick<
  Env,
  | 'DATABASE_URL'
  | 'DATABASE_CONNECT_TIMEOUT_MS'
  | 'DATABASE_STATEMENT_TIMEOUT_MS'
  | 'DATABASE_SHUTDOWN_TIMEOUT_MS'
>;

/**
 * Pool with finite bounds, verified against pg 8.23 / pg-pool 3.14:
 * - connectionTimeoutMillis destroys a socket whose connect/handshake stalls and
 *   also bounds waiting for a free pooled client;
 * - statement_timeout makes the server cancel long statements;
 * - query_timeout fails a query whose response never arrives; the adapter uses
 *   pool.query, which then releases the client with an error and pg destroys
 *   the socket of the still-active query.
 */
export function createPool(config: DatabaseConfig): Pool {
  return new Pool({
    connectionString: config.DATABASE_URL,
    connectionTimeoutMillis: config.DATABASE_CONNECT_TIMEOUT_MS,
    statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
    query_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS + QUERY_TIMEOUT_MARGIN_MS,
  });
}

export interface PoolStats {
  total: number;
  idle: number;
  waiting: number;
}

/**
 * Application database client. Connects lazily on first query so that the
 * process can start (and report not-ready) while the database is unavailable.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly pool: Pool;
  private readonly shutdownTimeoutMs: number;
  private readonly logger: Logger;

  constructor(@Inject(APP_CONFIG) config: Env) {
    const pool = createPool(config);
    super({ adapter: new PrismaPg(pool) });
    this.pool = pool;
    this.shutdownTimeoutMs = config.DATABASE_SHUTDOWN_TIMEOUT_MS;
    this.logger = new Logger(PrismaService.name);
    // An idle client error without a listener would crash the process.
    pool.on('error', (error) => {
      this.logger.warn({ message: 'Idle database connection failed', errorName: error.name });
    });
  }

  poolStats(): PoolStats {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  /**
   * Waits for in-flight work to drain, but never longer than the shutdown
   * timeout: pool.end() waits for checked-out clients, which a stalled
   * operation would hold until its own timeout.
   */
  async onModuleDestroy(): Promise<void> {
    const drained = (async () => {
      await this.$disconnect();
      await this.pool.end();
    })().then(
      () => 'drained' as const,
      (error: unknown) => {
        this.logger.warn({
          message: 'Database shutdown failed',
          errorName: error instanceof Error ? error.name : typeof error,
        });
        return 'failed' as const;
      },
    );
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.shutdownTimeoutMs);
    });
    const outcome = await Promise.race([drained, timedOut]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      // Remaining sockets close when their own timeouts fire or the process exits.
      this.logger.warn({
        message: 'Database pool did not drain before shutdown timeout',
        ...this.poolStats(),
      });
    }
  }
}

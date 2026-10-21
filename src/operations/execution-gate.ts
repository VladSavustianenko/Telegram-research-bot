import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { abortableSleep } from '../common/abortable-sleep';
import { errorInfo } from '../common/error-info';
import { AppLifecycle } from '../common/lifecycle';
import { PrismaService } from '../database/prisma.service';
import { readHold } from './hold';
import { readSchemaState, schemaReady } from './schema-state';

/** Names of the migrations this build ships (default: read from prisma/migrations). */
export const SHIPPED_MIGRATIONS = Symbol('SHIPPED_MIGRATIONS');
export type ShippedMigrations = () => string[];

/**
 * - `checking`: not evaluated yet, or the database could not be read;
 * - `schema_pending`: a shipped migration is not applied, or one failed;
 * - `held`: an operational hold is set (restored or suspect database);
 * - `open`: execution may start.
 */
export type GateState = 'checking' | 'schema_pending' | 'held' | 'open';

/** How long bootstrap waits for the first evaluation before continuing in the background. */
const FIRST_CHECK_WAIT_MS = 2_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** Re-evaluation interval while the schema is incomplete or a hold is set. */
const RECHECK_MS = 30_000;

/**
 * Startup gate for everything that acts (TRB-100, docs/OPERATIONS.md).
 *
 * Opens once the database has every migration this build ships (and none
 * failed) and no operational hold is set. Until then the process serves
 * health checks only: no background component starts and the webhook answers
 * 503, so Telegram keeps the updates and retries them later. This makes a
 * failed or skipped migration stop normal startup, and keeps a restored
 * database quarantined, independently of the platform's deployment checks.
 *
 * Evaluated at bootstrap and then re-evaluated (with backoff while the database
 * is unreachable) until it opens; it never closes again in a running process.
 * A hold set later takes effect at the next start (docs/OPERATIONS.md).
 */
@Injectable()
export class ExecutionGate implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ExecutionGate.name);
  private readonly controller = new AbortController();
  private current: GateState = 'checking';
  private readonly callbacks: (() => void | Promise<void>)[] = [];
  private checking: Promise<void> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    lifecycle: AppLifecycle,
    @Inject(SHIPPED_MIGRATIONS) private readonly shipped: ShippedMigrations,
  ) {
    lifecycle.shutdownSignal.addEventListener('abort', () => this.controller.abort(), {
      once: true,
    });
  }

  get state(): GateState {
    return this.current;
  }

  get open(): boolean {
    return this.current === 'open';
  }

  /** Runs `callback` once the gate is open (now, or when it opens). */
  whenOpen(callback: () => void | Promise<void>): void {
    if (this.open) {
      void this.run(callback);
    } else {
      this.callbacks.push(callback);
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    this.checking ??= this.evaluateUntilOpen();
    await Promise.race([this.checking, abortableSleep(FIRST_CHECK_WAIT_MS)]);
  }

  async onModuleDestroy(): Promise<void> {
    this.controller.abort();
    await Promise.race([this.checking, abortableSleep(1_000)]);
  }

  /**
   * One evaluation now (also used by tests and after an operator action);
   * opening runs the waiting components. Returns the resulting state.
   */
  async evaluateNow(): Promise<GateState> {
    if (this.open) return 'open';
    const next = await this.evaluate();
    if (this.controller.signal.aborted || this.open) return this.current;
    this.transition(next);
    if (next === 'open') {
      for (const callback of this.callbacks.splice(0)) await this.run(callback);
    }
    return next;
  }

  private async evaluateUntilOpen(): Promise<void> {
    const signal = this.controller.signal;
    let retryMs = RETRY_MIN_MS;
    while (!signal.aborted) {
      const next = await this.evaluateNow();
      if (next === 'open' || signal.aborted) return;
      if (next === 'checking') {
        await abortableSleep(retryMs, signal);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      } else {
        retryMs = RETRY_MIN_MS;
        await abortableSleep(RECHECK_MS, signal);
      }
    }
  }

  private async evaluate(): Promise<GateState> {
    try {
      const schema = await readSchemaState(this.prisma, this.shipped());
      if (!schemaReady(schema)) {
        if (this.current !== 'schema_pending') {
          this.logger.error({
            message: 'Database schema is not at this build; execution stays stopped',
            pending: schema.pending.length,
            failed: schema.failed,
          });
        }
        return 'schema_pending';
      }
      if (schema.unknown.length > 0 && this.current === 'checking') {
        this.logger.warn({
          message: 'Database has migrations unknown to this build (older image on a newer schema)',
          unknown: schema.unknown,
        });
      }
      const hold = await readHold(this.prisma);
      if (hold) {
        if (this.current !== 'held') {
          this.logger.warn({
            message: 'Operational hold is set; execution stays stopped',
            setBy: hold.setBy,
            since: hold.createdAt.toISOString(),
          });
        }
        return 'held';
      }
      return 'open';
    } catch (error) {
      if (this.current === 'checking') {
        this.logger.warn({ message: 'Execution gate check failed; retrying', ...errorInfo(error) });
      }
      return this.current === 'open' ? 'open' : 'checking';
    }
  }

  private transition(next: GateState): void {
    if (next === this.current) return;
    const previous = this.current;
    this.current = next;
    if (next === 'open') this.logger.log({ message: 'Execution gate open', previous });
  }

  private async run(callback: () => void | Promise<void>): Promise<void> {
    try {
      await callback();
    } catch (error) {
      this.logger.error({ message: 'Component failed to start', ...errorInfo(error) });
    }
  }
}

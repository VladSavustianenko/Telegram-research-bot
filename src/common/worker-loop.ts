import type { Logger } from '@nestjs/common';
import { abortableSleep } from './abortable-sleep';
import { errorInfo } from './error-info';
import type { AppLifecycle } from './lifecycle';

/** A loop is reported stalled when no pass finished for 3 intervals plus this margin. */
const STALL_MARGIN_MS = 300_000;

/** Readiness threshold for a loop with the given interval (see AppLifecycle). */
export function loopStaleAfterMs(intervalMs: number): number {
  return intervalMs * 3 + STALL_MARGIN_MS;
}

/**
 * Runs `tick` repeatedly: immediately again after a tick that did work,
 * otherwise after `intervalMs`. Errors are logged (name/code only) and the loop
 * continues. `stop` aborts sleeps and waits a bounded time for the current tick.
 * With a lifecycle (TRB-100), the loop reports itself up under `component`,
 * beats after every pass and stops taking new passes as soon as the process
 * shutdown begins.
 */
export class WorkerLoop {
  private readonly controller = new AbortController();
  private running: Promise<void> | undefined;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: (signal: AbortSignal) => Promise<boolean>,
    private readonly logger: Logger,
    private readonly lifecycle?: { lifecycle: AppLifecycle; component: string },
  ) {
    lifecycle?.lifecycle.shutdownSignal.addEventListener('abort', () => this.controller.abort(), {
      once: true,
    });
  }

  start(): void {
    if (this.controller.signal.aborted) return;
    this.lifecycle?.lifecycle.mark(this.lifecycle.component, 'up');
    this.running ??= this.run();
  }

  async stop(timeoutMs: number): Promise<void> {
    this.controller.abort();
    if (!this.running) return;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const outcome = await Promise.race([this.running.then(() => 'stopped' as const), timedOut]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      this.logger.warn({ message: `${this.name} did not stop before the shutdown timeout` });
    }
  }

  private async run(): Promise<void> {
    const signal = this.controller.signal;
    while (!signal.aborted) {
      let worked = false;
      try {
        worked = await this.tick(signal);
      } catch (error) {
        this.logger.error({ message: `${this.name} tick failed`, ...errorInfo(error) });
      }
      this.lifecycle?.lifecycle.heartbeat(this.lifecycle.component);
      if (!worked) await abortableSleep(this.intervalMs, signal);
    }
  }
}

import { Injectable } from '@nestjs/common';

/** What readiness reports for one background component. */
export type ComponentState = 'starting' | 'up' | 'failed' | 'stopped';

interface Component {
  state: ComponentState;
  /** A loop that has not finished a pass for this long counts as stalled. */
  staleAfterMs: number | null;
  lastBeatAt: number;
}

export interface ComponentReport {
  /** True when every registered component is up and none is stalled. */
  healthy: boolean;
  /** Names of components that are not up (never exposed publicly). */
  down: string[];
  registered: number;
}

/**
 * Process lifecycle (TRB-100, docs/OPERATIONS.md).
 *
 * Shutdown: `beginShutdown()` is called first on SIGTERM/SIGINT, before Nest's
 * module hooks run. It aborts `shutdownSignal` at once for every component, so
 * that the scheduler, dispatchers, retention, polling and both queue workers all
 * stop taking new work together; the module hooks then only wait (bounded) for
 * work already in progress. Without it, Nest would stop modules one after the
 * other and a later module could keep starting work while an earlier one drains.
 *
 * Readiness: each background component the configuration requires registers
 * here and reports when it actually started, failed or stalled, so readiness
 * does not stay healthy because startup once looked successful.
 */
@Injectable()
export class AppLifecycle {
  private readonly controller = new AbortController();
  private readonly components = new Map<string, Component>();

  get shutdownSignal(): AbortSignal {
    return this.controller.signal;
  }

  get shuttingDown(): boolean {
    return this.controller.signal.aborted;
  }

  /** Idempotent. */
  beginShutdown(): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    for (const component of this.components.values()) {
      if (component.state !== 'failed') component.state = 'stopped';
    }
  }

  /** Declares a component this process requires; it is "starting" until marked up. */
  register(name: string, options: { staleAfterMs?: number } = {}): void {
    this.components.set(name, {
      state: this.shuttingDown ? 'stopped' : 'starting',
      staleAfterMs: options.staleAfterMs ?? null,
      lastBeatAt: Date.now(),
    });
  }

  mark(name: string, state: ComponentState): void {
    const component = this.components.get(name);
    if (!component) return;
    if (this.shuttingDown && state !== 'failed') {
      component.state = 'stopped';
      return;
    }
    component.state = state;
    component.lastBeatAt = Date.now();
  }

  /** A loop finished a pass (successful or not). */
  heartbeat(name: string): void {
    const component = this.components.get(name);
    if (component) component.lastBeatAt = Date.now();
  }

  report(now = Date.now()): ComponentReport {
    const down: string[] = [];
    for (const [name, component] of this.components) {
      const stalled =
        component.state === 'up' &&
        component.staleAfterMs !== null &&
        now - component.lastBeatAt > component.staleAfterMs;
      if (component.state !== 'up' || stalled) down.push(name);
    }
    return { healthy: down.length === 0, down, registered: this.components.size };
  }
}

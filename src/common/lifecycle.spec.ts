import { Logger } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AppLifecycle } from './lifecycle';
import { WorkerLoop } from './worker-loop';

describe('AppLifecycle (TRB-100)', () => {
  it('reports registered components until they are up, and stalled loops', () => {
    const lifecycle = new AppLifecycle();
    expect(lifecycle.report()).toEqual({ healthy: true, down: [], registered: 0 });
    lifecycle.register('worker');
    lifecycle.register('loop', { staleAfterMs: 1_000 });
    expect(lifecycle.report().down).toEqual(['worker', 'loop']);
    lifecycle.mark('worker', 'up');
    lifecycle.mark('loop', 'up');
    expect(lifecycle.report().healthy).toBe(true);
    expect(lifecycle.report(Date.now() + 5_000).down).toEqual(['loop']);
    lifecycle.heartbeat('loop');
    lifecycle.mark('worker', 'failed');
    expect(lifecycle.report().down).toEqual(['worker']);
  });

  it('stops every component at once and keeps them stopped', () => {
    const lifecycle = new AppLifecycle();
    lifecycle.register('a');
    lifecycle.mark('a', 'up');
    let aborted = false;
    lifecycle.shutdownSignal.addEventListener('abort', () => (aborted = true));
    lifecycle.beginShutdown();
    lifecycle.beginShutdown();
    expect(aborted).toBe(true);
    expect(lifecycle.shuttingDown).toBe(true);
    lifecycle.mark('a', 'up');
    expect(lifecycle.report().down).toEqual(['a']);
  });

  it('a worker loop takes no further pass once shutdown begins', async () => {
    const lifecycle = new AppLifecycle();
    lifecycle.register('loop');
    let passes = 0;
    const loop = new WorkerLoop(
      'test loop',
      10,
      () => {
        passes += 1;
        return Promise.resolve(false);
      },
      new Logger('test'),
      { lifecycle, component: 'loop' },
    );
    loop.start();
    expect(lifecycle.report().healthy).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    lifecycle.beginShutdown();
    const seen = passes;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(passes).toBeLessThanOrEqual(seen + 1);
    await loop.stop(1_000);
    loop.start(); // no restart after shutdown
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(passes).toBeLessThanOrEqual(seen + 1);
  });
});

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../app.module';
import { parseEnv } from '../config/env.schema';
import { PrismaService } from '../database/prisma.service';
import { httpServer } from '../../test/support/http';
import { openGate } from '../../test/support/open-gate';
import { ExecutionGate } from '../operations/execution-gate';

class FakePrisma {
  queryRaw = vi.fn<() => Promise<unknown>>().mockResolvedValue([{ '?column?': 1 }]);
  $queryRaw = (): Promise<unknown> => this.queryRaw();
  $disconnect = vi.fn().mockResolvedValue(undefined);
}

describe('health endpoints', () => {
  let app: INestApplication | undefined;

  async function start(prisma: FakePrisma): Promise<INestApplication> {
    const config = parseEnv({ DATABASE_URL: 'postgresql://unused@localhost:1/unused' });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(ExecutionGate)
      .useValue(openGate())
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    return app;
  }

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('reports liveness without touching the database', async () => {
    const prisma = new FakePrisma();
    const server = httpServer(await start(prisma));
    await request(server).get('/health/live').expect(200, { status: 'ok' });
    expect(prisma.queryRaw).not.toHaveBeenCalled();
  });

  it('reports ready when the database answers', async () => {
    const server = httpServer(await start(new FakePrisma()));
    await request(server)
      .get('/health/ready')
      .expect(200, {
        status: 'ok',
        checks: {
          config: 'up',
          database: 'up',
          queue: 'disabled',
          schema: 'up',
          workers: 'disabled',
          execution: 'open',
        },
      });
  });

  it('returns 503 without leaking error details when the database fails', async () => {
    const prisma = new FakePrisma();
    prisma.queryRaw.mockRejectedValue(new Error('connect ECONNREFUSED postgresql://user:pw@db'));
    const server = httpServer(await start(prisma));
    const response = await request(server).get('/health/ready').expect(503);
    expect(response.body).toEqual({
      status: 'error',
      checks: {
        config: 'up',
        database: 'down',
        queue: 'disabled',
        schema: 'up',
        workers: 'disabled',
        execution: 'open',
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('ECONNREFUSED');
  });

  it('returns 503 when the database check hangs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const prisma = new FakePrisma();
      prisma.queryRaw.mockReturnValue(new Promise(() => undefined));
      const server = httpServer(await start(prisma));
      const pending = request(server).get('/health/ready');
      const result = pending.then((response) => response.status);
      await vi.waitFor(() => expect(prisma.queryRaw).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await result).toBe(503);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one database probe between concurrent readiness requests', async () => {
    const prisma = new FakePrisma();
    let answer: (value: unknown) => void = () => undefined;
    prisma.queryRaw.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const server = httpServer(await start(prisma));

    const responses = Promise.all([1, 2, 3].map(() => request(server).get('/health/ready')));
    await vi.waitFor(() => expect(prisma.queryRaw).toHaveBeenCalled());
    answer([{ '?column?': 1 }]);

    expect((await responses).map((response) => response.status)).toEqual([200, 200, 200]);
    expect(prisma.queryRaw).toHaveBeenCalledTimes(1);
  });
});

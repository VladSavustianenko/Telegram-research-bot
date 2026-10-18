import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { parseEnv } from '../../src/config/env.schema';
import { PrismaService } from '../../src/database/prisma.service';
import { READINESS_TIMEOUT_MS } from '../../src/health/health.service';
import { httpServer } from '../support/http';
import { TcpFixture } from '../support/tcp-fixture';

describe('database timeouts against real PostgreSQL', () => {
  let fixture: TcpFixture | undefined;
  let app: INestApplication | undefined;

  async function start(databaseUrl: string, env: Record<string, string>) {
    const config = parseEnv({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, ...env });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
      .overrideProvider(READINESS_TIMEOUT_MS)
      .useValue(200)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    return { app, prisma: app.get(PrismaService) };
  }

  async function closeApp(): Promise<number> {
    const started = Date.now();
    const closing = app;
    app = undefined;
    await closing?.close();
    return Date.now() - started;
  }

  afterEach(async () => {
    try {
      await closeApp();
    } finally {
      await fixture?.close();
      fixture = undefined;
    }
  });

  it('recovers readiness after a stalled database endpoint becomes healthy', async () => {
    const real = new URL(inject('databaseUrl'));
    fixture = await TcpFixture.start({ host: real.hostname, port: Number(real.port) });
    const viaFixture = new URL(real.toString());
    viaFixture.hostname = '127.0.0.1';
    viaFixture.port = String(fixture.port);

    const { app, prisma } = await start(viaFixture.toString(), {
      DATABASE_CONNECT_TIMEOUT_MS: '500',
    });
    const server = httpServer(app);

    await request(server).get('/health/ready').expect(503);
    expect(fixture.openConnections).toBe(1);

    fixture.mode = 'forward';
    const deadline = Date.now() + 5_000;
    let status = 0;
    while (status !== 200 && Date.now() < deadline) {
      status = (await request(server).get('/health/ready')).status;
    }
    expect(status).toBe(200);

    // The stalled connection was destroyed; only the healthy pooled one remains.
    await fixture.waitForOpenConnections((open) => open === 1, 2_000);
    expect(prisma.poolStats().total).toBe(1);
  });

  it('cancels a long statement at the statement timeout and stays ready', async () => {
    const { app, prisma } = await start(inject('databaseUrl'), {
      DATABASE_STATEMENT_TIMEOUT_MS: '300',
    });
    const started = Date.now();
    await expect(prisma.$queryRaw`SELECT pg_sleep(5)`).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);

    await request(httpServer(app)).get('/health/ready').expect(200);
    expect(prisma.poolStats()).toMatchObject({ waiting: 0 });
    expect(prisma.poolStats().total).toBeLessThanOrEqual(1);
  });

  it('bounds shutdown while a statement is still running', async () => {
    const { prisma } = await start(inject('databaseUrl'), {
      DATABASE_STATEMENT_TIMEOUT_MS: '1500',
      DATABASE_SHUTDOWN_TIMEOUT_MS: '300',
    });
    const running = prisma.$queryRaw`SELECT pg_sleep(5)`.then(
      () => 'completed',
      () => 'cancelled',
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(await closeApp()).toBeLessThan(1_000);
    // The server-side statement timeout still ends the abandoned statement.
    expect(await running).toBe('cancelled');
  });
});

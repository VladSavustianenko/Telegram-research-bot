import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { httpServer } from '../../test/support/http';
import { TcpFixture } from '../../test/support/tcp-fixture';
import { AppModule } from '../app.module';
import { parseEnv } from '../config/env.schema';
import { PrismaService } from '../database/prisma.service';
import { READINESS_TIMEOUT_MS } from './health.service';

// Real pg driver against a loopback TCP server that accepts connections but
// never completes the PostgreSQL handshake. Assertions count actual sockets.

const READINESS_TIMEOUT = 100;

describe('readiness against a stalled database endpoint', () => {
  let fixture: TcpFixture | undefined;
  let app: INestApplication | undefined;

  async function start(timeouts: { connect: number; shutdown: number }) {
    fixture = await TcpFixture.start();
    const config = parseEnv({
      NODE_ENV: 'test',
      DATABASE_URL: `postgresql://u:p@127.0.0.1:${fixture.port}/db`,
      DATABASE_CONNECT_TIMEOUT_MS: String(timeouts.connect),
      DATABASE_STATEMENT_TIMEOUT_MS: '1000',
      DATABASE_SHUTDOWN_TIMEOUT_MS: String(timeouts.shutdown),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
      .overrideProvider(READINESS_TIMEOUT_MS)
      .useValue(READINESS_TIMEOUT)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    return { fixture, app, prisma: app.get(PrismaService) };
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

  it('shares one in-flight probe and releases its connection at the connect timeout', async () => {
    const { fixture, app, prisma } = await start({ connect: 1_500, shutdown: 5_000 });
    const server = httpServer(app);

    for (let i = 0; i < 5; i += 1) {
      await request(server).get('/health/ready').expect(503);
    }
    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () => request(server).get('/health/ready')),
    );
    expect(concurrent.map((response) => response.status)).toEqual([503, 503, 503, 503, 503]);
    await request(server).get('/health/live').expect(200);

    // Ten probes within the connect timeout opened exactly one connection.
    expect(fixture.accepted).toBe(1);
    expect(fixture.openConnections).toBeLessThanOrEqual(1);
    expect(prisma.poolStats().total).toBeLessThanOrEqual(1);

    // The driver timeout destroys the stalled socket; nothing is left behind.
    await fixture.waitForOpenConnections((open) => open === 0, 3_000);
    expect(prisma.poolStats()).toEqual({ total: 0, idle: 0, waiting: 0 });

    // The finished probe is not reused: the next request starts a new one.
    await request(server).get('/health/ready').expect(503);
    expect(fixture.accepted).toBe(2);
    expect(fixture.openConnections).toBeLessThanOrEqual(1);
  });

  it('drains the stalled connection on shutdown within the connect timeout', async () => {
    const { fixture, app } = await start({ connect: 300, shutdown: 5_000 });
    await request(httpServer(app)).get('/health/ready').expect(503);
    expect(fixture.openConnections).toBe(1);

    expect(await closeApp()).toBeLessThan(2_000);
    await fixture.waitForOpenConnections((open) => open === 0, 1_000);
  });

  it('bounds shutdown by the shutdown timeout when a connection stays stalled', async () => {
    const { fixture, app } = await start({ connect: 60_000, shutdown: 300 });
    await request(httpServer(app)).get('/health/ready').expect(503);
    expect(fixture.openConnections).toBe(1);

    expect(await closeApp()).toBeLessThan(2_000);
  });
});

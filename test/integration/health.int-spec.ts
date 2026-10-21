import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { parseEnv } from '../../src/config/env.schema';
import { PrismaService } from '../../src/database/prisma.service';
import { httpServer } from '../support/http';

describe('health against real PostgreSQL', () => {
  let app: INestApplication | undefined;

  async function start(databaseUrl: string): Promise<INestApplication> {
    const config = parseEnv({ NODE_ENV: 'test', DATABASE_URL: databaseUrl });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(config)],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    return app;
  }

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('is ready when connected to the disposable test database', async () => {
    const started = await start(inject('databaseUrl'));
    await request(httpServer(started))
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

    const prisma = started.get(PrismaService);
    const [row] = await prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    expect(row?.name).toMatch(/^trb_it_\d+_[0-9a-f]{8}$/);
  });

  it('has Prisma migrations applied to the disposable database', async () => {
    const prisma = (await start(inject('databaseUrl'))).get(PrismaService);
    const [row] = await prisma.$queryRaw<{ exists: boolean }[]>`
      SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS exists`;
    expect(row?.exists).toBe(true);
  });

  it('starts but reports not ready when the database is unreachable', async () => {
    const started = await start('postgresql://nobody:nothing@127.0.0.1:1/none');
    await request(httpServer(started)).get('/health/ready').expect(503);
    await request(httpServer(started)).get('/health/live').expect(200);
  });
});

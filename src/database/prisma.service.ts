import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { APP_CONFIG } from '../config/config.module';
import { Env } from '../config/env.schema';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Application database client. Connects lazily on first query so that the
 * process can start (and report not-ready) while the database is unavailable.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: Env) {
    super({ adapter: new PrismaPg({ connectionString: config.DATABASE_URL }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

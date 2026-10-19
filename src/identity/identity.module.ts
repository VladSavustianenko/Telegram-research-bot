import { Inject, Injectable, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { errorInfo } from '../common/error-info';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../database/prisma.service';
import { bootstrapAdministrators } from './users';

/**
 * Runs administrator bootstrap at startup. A failure (for example, the
 * database is unreachable) is logged, not fatal: the same configuration is
 * applied lazily to each sender on their next update, and authorization
 * always requires the current ADMIN_TELEGRAM_IDS as well as the stored role.
 */
@Injectable()
export class AdminBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminBootstrapService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const summary = await bootstrapAdministrators(this.prisma, this.config);
      if (!summary.skipped) this.logger.log({ message: 'Administrator bootstrap', ...summary });
    } catch (error) {
      this.logger.error({ message: 'Administrator bootstrap failed', ...errorInfo(error) });
    }
  }
}

@Module({ providers: [AdminBootstrapService] })
export class IdentityModule {}

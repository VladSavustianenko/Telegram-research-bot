import { DynamicModule, Module } from '@nestjs/common';
import { CommonModule } from './common/common.module';
import { AppConfigModule } from './config/config.module';
import { Env } from './config/env.schema';
import { DatabaseModule } from './database/database.module';
import { DeliveryModule } from './delivery/delivery.module';
import { HealthModule } from './health/health.module';
import { IdentityModule } from './identity/identity.module';
import { OperationsModule } from './operations/operations.module';
import { ResearchModule } from './research/research.module';
import { RetentionModule } from './retention/retention.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { TelegramModule } from './telegram/telegram.module';

@Module({})
export class AppModule {
  static forRoot(config: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        AppConfigModule.forRoot(config),
        CommonModule,
        DatabaseModule,
        OperationsModule,
        HealthModule,
        IdentityModule,
        TelegramModule,
        ResearchModule,
        SchedulingModule,
        DeliveryModule,
        RetentionModule,
      ],
    };
  }
}

import { DynamicModule, Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { Env } from './config/env.schema';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';

@Module({})
export class AppModule {
  static forRoot(config: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [AppConfigModule.forRoot(config), DatabaseModule, HealthModule],
    };
  }
}

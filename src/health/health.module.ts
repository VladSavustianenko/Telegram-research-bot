import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import {
  DEFAULT_READINESS_TIMEOUT_MS,
  HealthService,
  READINESS_TIMEOUT_MS,
} from './health.service';

@Module({
  controllers: [HealthController],
  providers: [
    HealthService,
    { provide: READINESS_TIMEOUT_MS, useValue: DEFAULT_READINESS_TIMEOUT_MS },
  ],
})
export class HealthModule {}

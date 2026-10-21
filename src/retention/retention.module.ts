import { Module } from '@nestjs/common';
import { RetentionService } from './retention.service';

/** Retention cleanup (TRB-090, docs/RETENTION.md). */
@Module({
  providers: [RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}

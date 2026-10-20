import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';

/** Persistent scheduling of daily and weekly tasks (TRB-070, docs/SCHEDULING.md). */
@Module({
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class SchedulingModule {}

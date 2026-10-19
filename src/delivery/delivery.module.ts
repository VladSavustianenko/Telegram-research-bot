import { Module } from '@nestjs/common';
import { DeliveryWorker } from './delivery-worker.service';

@Module({
  providers: [DeliveryWorker],
  exports: [DeliveryWorker],
})
export class DeliveryModule {}

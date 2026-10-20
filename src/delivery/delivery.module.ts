import { Module } from '@nestjs/common';
import { ResearchModule } from '../research/research.module';
import { DeliveryDispatcher } from './delivery-dispatcher';
import { DeliveryWorker } from './delivery-worker.service';

/** Delivery (docs/DELIVERY.md): the delivery outbox dispatcher and the delivery-queue worker. */
@Module({
  imports: [ResearchModule],
  providers: [DeliveryDispatcher, DeliveryWorker],
  exports: [DeliveryWorker, DeliveryDispatcher],
})
export class DeliveryModule {}

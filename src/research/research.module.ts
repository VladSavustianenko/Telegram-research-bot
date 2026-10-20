import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { QueueService } from '../queue/queue.service';
import { OutboxDispatcher } from './outbox-dispatcher';
import { FakeResearchProvider } from './provider/fake.provider';
import { OpenAiResearchProvider } from './provider/openai.provider';
import { RESEARCH_PROVIDER, type ResearchProvider } from './provider/provider.types';
import { ResearchWorker } from './research-worker.service';

/** Provider selection is explicit: live only when RESEARCH_MODE=live; never a silent fallback. */
export function createResearchProvider(config: Env): ResearchProvider | null {
  if (config.RESEARCH_MODE === 'fake') return new FakeResearchProvider();
  if (config.RESEARCH_MODE !== 'live') return null;
  if (!config.OPENAI_API_KEY) throw new Error('RESEARCH_MODE=live requires OPENAI_API_KEY');
  return OpenAiResearchProvider.create({
    apiKey: config.OPENAI_API_KEY,
    httpTimeoutMs: config.OPENAI_HTTP_TIMEOUT_MS,
  });
}

/**
 * Research execution (docs/QUEUE.md): the pg-boss queue, the outbox
 * dispatcher with its recovery sweep, and the worker that executes runs.
 * pg-boss is the only path that leads to a provider submission.
 */
@Module({
  providers: [
    QueueService,
    OutboxDispatcher,
    ResearchWorker,
    { provide: RESEARCH_PROVIDER, inject: [APP_CONFIG], useFactory: createResearchProvider },
  ],
  exports: [ResearchWorker, QueueService, OutboxDispatcher],
})
export class ResearchModule {}

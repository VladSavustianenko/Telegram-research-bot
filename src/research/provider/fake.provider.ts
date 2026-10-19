import { randomUUID } from 'node:crypto';
import { FAKE_FIXTURES, fixtureFor, type FixtureKey } from './fake-fixtures';
import {
  ProviderError,
  type ProviderSnapshot,
  type ResearchProvider,
  type ResearchRequest,
} from './provider.types';

/**
 * Simulated provider for RESEARCH_MODE=fake. No network. Mimics the background
 * lifecycle (queued, then completed on the first poll) and echoes the bounds.
 * The fixture key is encoded in the response ID so polling survives restarts.
 * Every snapshot is marked `simulated`.
 */
export class FakeResearchProvider implements ResearchProvider {
  readonly kind = 'fake' as const;
  private readonly requests = new Map<string, ResearchRequest>();

  submit(request: ResearchRequest): Promise<ProviderSnapshot> {
    const id = `fake_${fixtureFor(request.input)}_${randomUUID()}`;
    this.requests.set(id, request);
    return Promise.resolve(this.snapshot(id, 'queued'));
  }

  retrieve(responseId: string): Promise<ProviderSnapshot> {
    return Promise.resolve(this.snapshot(responseId, 'completed'));
  }

  cancel(responseId: string): Promise<ProviderSnapshot> {
    return Promise.resolve(this.snapshot(responseId, 'cancelled'));
  }

  private snapshot(id: string, status: ProviderSnapshot['status']): ProviderSnapshot {
    const key = /^fake_(football|shopping|news|generic)_/.exec(id)?.[1] as FixtureKey | undefined;
    if (!key) throw new ProviderError('FAKE_UNKNOWN_RESPONSE', 'not_accepted', true);
    const request = this.requests.get(id);
    const fixture = FAKE_FIXTURES[key];
    const completed = status === 'completed';
    return {
      id,
      status,
      model: 'simulated',
      textParts: completed ? fixture.parts : [],
      webSearchCalls: completed ? fixture.searches : 0,
      sources: [],
      usage: completed
        ? {
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cachedInputTokens: 0,
            totalTokens: 0,
          }
        : null,
      incompleteReason: null,
      errorCode: null,
      bounds: {
        maxOutputTokens: request?.maxOutputTokens ?? null,
        maxToolCalls: request?.maxToolCalls ?? null,
        toolChoice: 'required',
        webSearchTool: true,
      },
      simulated: true,
    };
  }
}

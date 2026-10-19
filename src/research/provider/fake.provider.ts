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
 * The fixture key and the requested bounds are encoded in the response ID, so
 * polling after a restart still sees the echoed bounds (like a real provider,
 * which stores them with the response). Every snapshot is marked `simulated`.
 */
export class FakeResearchProvider implements ResearchProvider {
  readonly kind = 'fake' as const;

  submit(request: ResearchRequest): Promise<ProviderSnapshot> {
    const key = fixtureFor(request.input);
    const id = `fake_${key}_${request.maxOutputTokens}_${request.maxToolCalls}_${randomUUID()}`;
    return Promise.resolve().then(() => this.snapshot(id, 'queued'));
  }

  retrieve(responseId: string): Promise<ProviderSnapshot> {
    return Promise.resolve().then(() => this.snapshot(responseId, 'completed'));
  }

  cancel(responseId: string): Promise<ProviderSnapshot> {
    return Promise.resolve().then(() => this.snapshot(responseId, 'cancelled'));
  }

  private snapshot(id: string, status: ProviderSnapshot['status']): ProviderSnapshot {
    const match = /^fake_(football|shopping|news|generic)_(\d+)_(\d+)_/.exec(id);
    if (!match) throw new ProviderError('FAKE_UNKNOWN_RESPONSE', 'not_accepted', true);
    const key = match[1] as FixtureKey;
    const fixture = FAKE_FIXTURES[key];
    const completed = status === 'completed';
    return {
      id,
      status,
      model: 'simulated',
      textParts: completed ? fixture.parts : [],
      webSearchCalls: completed ? fixture.searches : 0,
      // Simulated items carry the same diagnostic shape as real ones.
      toolItems: completed
        ? Array.from({ length: fixture.searches }, (_, index) => ({
            itemId: `${id}_ws_${index + 1}`,
            position: index,
            type: 'web_search_call',
            status: 'completed',
            actionType: 'search',
          }))
        : [],
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
        maxOutputTokens: Number(match[2]),
        maxToolCalls: Number(match[3]),
        toolChoice: 'required',
        webSearchTool: true,
      },
      simulated: true,
    };
  }
}

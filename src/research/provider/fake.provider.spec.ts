import { describe, expect, it } from 'vitest';
import { FakeResearchProvider } from './fake.provider';
import { unconfirmedBounds, type ResearchRequest } from './provider.types';

const request: ResearchRequest = {
  model: 'simulated',
  instructions: 'i',
  input: 'football fixtures',
  maxOutputTokens: 2000,
  maxToolCalls: 3,
  runId: 'run-1',
};

describe('FakeResearchProvider', () => {
  it('echoes the requested bounds even when polled by a new process', async () => {
    const submitted = await new FakeResearchProvider().submit(request);
    const afterRestart = await new FakeResearchProvider().retrieve(submitted.id);
    expect(afterRestart).toMatchObject({ status: 'completed', simulated: true });
    expect(unconfirmedBounds(request, afterRestart.bounds)).toEqual([]);
    expect(unconfirmedBounds({ ...request, maxToolCalls: 4 }, afterRestart.bounds)).toEqual([
      'max_tool_calls',
    ]);
  });

  it('reports an unknown response ID as gone', async () => {
    await expect(new FakeResearchProvider().retrieve('resp_other')).rejects.toMatchObject({
      gone: true,
    });
  });
});

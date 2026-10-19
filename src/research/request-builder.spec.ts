import { describe, expect, it } from 'vitest';
import { parseEnv } from '../config/env.schema';
import { buildResearchContext, snapshotRunConfig } from './request-builder';

describe('buildResearchContext', () => {
  it('gives UTC and local time, offset, Monday-Sunday week and delay in the task zone', () => {
    const context = buildResearchContext(
      new Date('2026-10-18T21:30:00Z'), // Sunday in UTC, already Monday 00:30 in Kyiv
      new Date('2026-10-18T21:00:00Z'),
      'Europe/Kyiv',
    );
    expect(context).toEqual({
      utcNow: '2026-10-18T21:30:00Z',
      localNow: '2026-10-19 00:30',
      timeZone: 'Europe/Kyiv',
      utcOffset: '+03:00',
      currentWeek: { monday: '2026-10-19', sunday: '2026-10-25' },
      queuedAt: '2026-10-18T21:00:00Z',
      delayMinutes: 30,
    });
  });

  it('follows DST instead of a hard-coded offset', () => {
    const winter = buildResearchContext(
      new Date('2026-10-26T10:00:00Z'),
      new Date(),
      'Europe/Kyiv',
    );
    expect(winter.utcOffset).toBe('+02:00');
    expect(winter.localNow).toBe('2026-10-26 12:00');
    const ny = buildResearchContext(
      new Date('2026-10-18T03:00:00Z'),
      new Date(),
      'America/New_York',
    );
    expect(ny).toMatchObject({
      localNow: '2026-10-17 23:00',
      currentWeek: { monday: '2026-10-12' },
    });
  });
});

describe('snapshotRunConfig', () => {
  const base = { DATABASE_URL: 'postgresql://u:p@localhost:5434/db' };

  it('is null when research is disabled (the default)', () => {
    expect(snapshotRunConfig(parseEnv(base))).toBeNull();
  });

  it('uses simulated settings in fake mode and never an OpenAI model', () => {
    expect(snapshotRunConfig(parseEnv({ ...base, RESEARCH_MODE: 'fake' }))).toMatchObject({
      providerKind: 'fake',
      model: 'simulated',
    });
  });

  it('freezes the operator-selected model and bounds in live mode', () => {
    const snapshot = snapshotRunConfig(
      parseEnv({
        ...base,
        RESEARCH_MODE: 'live',
        OPENAI_API_KEY: 'k',
        OPENAI_MODEL: 'chosen',
        OUTPUT_TOKEN_LIMIT: '3000',
        TOOL_CALL_LIMIT: '2',
        RUN_DEADLINE_SECONDS: '240',
      }),
    );
    expect(snapshot).toMatchObject({
      providerKind: 'openai',
      model: 'chosen',
      maxOutputTokens: 3000,
      maxToolCalls: 2,
      deadlineSeconds: 240,
      timeZone: 'Europe/Kyiv',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { parseEnv } from '../config/env.schema';
import {
  RESEARCH_POLICY_VERSION,
  buildResearchContext,
  buildResearchRequest,
  snapshotRunConfig,
  type RunConfigSnapshot,
} from './request-builder';

const snapshot: RunConfigSnapshot = {
  policyVersion: RESEARCH_POLICY_VERSION,
  providerKind: 'fake',
  model: 'simulated',
  maxOutputTokens: 2000,
  maxToolCalls: 3,
  deadlineSeconds: 120,
  reasoningEffort: null,
  timeZone: 'Europe/Kyiv',
};

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
      currentMonth: { first: '2026-10-01', last: '2026-10-31' },
      previousSevenDays: { from: '2026-10-12 00:30', to: '2026-10-19 00:30' },
      nextSevenDays: { from: '2026-10-19 00:30', to: '2026-10-26 00:30' },
      queuedAt: '2026-10-18T21:00:00Z',
      delayMinutes: 30,
    });
  });

  it('uses the actual execution time and reports the planned time and delay of a scheduled run', () => {
    // Planned Sunday 2026-10-25 23:00 Kyiv; started Monday 01:30 (after the DST change).
    const context = buildResearchContext(
      new Date('2026-10-25T23:30:00Z'),
      new Date('2026-10-25T21:00:00Z'),
      'Europe/Kyiv',
      new Date('2026-10-25T21:00:00Z'),
    );
    expect(context).toMatchObject({
      localNow: '2026-10-26 01:30',
      utcOffset: '+02:00',
      // The current week follows the actual time: the new Monday, not the planned Sunday's week.
      currentWeek: { monday: '2026-10-26', sunday: '2026-11-01' },
      // Rolling seven days across the DST change keep the local wall time.
      previousSevenDays: { from: '2026-10-19 01:30', to: '2026-10-26 01:30' },
      scheduledFor: { utc: '2026-10-25T21:00:00Z', local: '2026-10-25 23:00' },
      delayMinutes: 150,
    });
    const request = buildResearchRequest('run', 'prompt', snapshot, context);
    expect(request.input).toContain(
      'Scheduled run planned for 2026-10-25 23:00 local (2026-10-25T21:00:00Z); actually started 150 minute(s) later.',
    );
    expect(request.input).toContain('Current time (UTC): 2026-10-25T23:30:00Z');
    expect(request.input).toContain('"Next seven days" (rolling, not a calendar week)');
    expect(request.input).toContain('do not assume a search period the task does not state');
    expect(request.input).not.toContain('Request queued at');
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

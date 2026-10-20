import { describe, expect, it } from 'vitest';
import {
  draftCallbackData,
  parseCallbackData,
  taskCallbackData,
  taskListCallbackData,
} from '../telegram/callback-data';
import {
  applyEvent,
  completeConfiguration,
  stepSequence,
  type DraftEvent,
  type DraftShape,
} from './draft-flow';
import { htmlParts } from './task-service';
import { describeSchedule, parseLocalTime, validateName, validatePrompt } from './task-validation';
import { previewView, taskCardView } from './task-views';

const limits = { promptMaxChars: 50 };
const start = (): DraftShape => ({
  mode: 'CREATE',
  section: null,
  step: 'NAME',
  data: { suggestedTimeZone: 'Europe/Kyiv' },
});

function run(shape: DraftShape, ...events: DraftEvent[]): DraftShape {
  return events.reduce((current, event) => {
    const next = applyEvent(current, event, limits);
    if (!next.ok) throw new Error(`rejected: ${next.error}`);
    return next.shape;
  }, shape);
}

describe('task dialog state machine', () => {
  it('walks the creation steps for each schedule kind', () => {
    const base = run(start(), { type: 'text', text: ' Футбол ' }, { type: 'text', text: 'матчі' });
    expect(base.step).toBe('SCHEDULE_KIND');

    const manual = run(base, { type: 'kind', kind: 'MANUAL' });
    expect(manual.step).toBe('TIME_ZONE');
    expect(run(manual, { type: 'suggested_zone' })).toMatchObject({
      step: 'PREVIEW',
      data: { name: 'Футбол', prompt: 'матчі', scheduleKind: 'MANUAL', timeZone: 'Europe/Kyiv' },
    });

    const daily = run(base, { type: 'kind', kind: 'DAILY' }, { type: 'text', text: '9:05' });
    expect(daily).toMatchObject({ step: 'TIME_ZONE', data: { localTime: '09:05' } });

    const weekly = run(
      base,
      { type: 'kind', kind: 'WEEKLY' },
      { type: 'weekday', weekday: 3 },
      { type: 'text', text: '18:30' },
      { type: 'text', text: 'america/new_york' },
    );
    expect(weekly).toMatchObject({
      step: 'PREVIEW',
      data: { weekday: 3, localTime: '18:30', timeZone: 'America/New_York' },
    });
    expect(completeConfiguration(weekly.data, limits)).toEqual({
      name: 'Футбол',
      prompt: 'матчі',
      scheduleKind: 'WEEKLY',
      weekday: 3,
      localTime: '18:30',
      timeZone: 'America/New_York',
    });
  });

  it('keeps values when moving back and clears incompatible fields when the kind changes', () => {
    const weekly = run(
      start(),
      { type: 'text', text: 'N' },
      { type: 'text', text: 'P' },
      { type: 'kind', kind: 'WEEKLY' },
      { type: 'weekday', weekday: 5 },
      { type: 'text', text: '07:00' },
    );
    const back = run(weekly, { type: 'back' }, { type: 'back' }, { type: 'back' });
    expect(back).toMatchObject({ step: 'SCHEDULE_KIND', data: { weekday: 5, localTime: '07:00' } });
    const daily = run(back, { type: 'kind', kind: 'DAILY' });
    expect(daily.data).not.toHaveProperty('weekday');
    expect(run(daily, { type: 'keep' }).data.localTime).toBe('07:00');
    const manual = run(back, { type: 'kind', kind: 'MANUAL' });
    expect(manual.data).not.toHaveProperty('weekday');
    expect(manual.data).not.toHaveProperty('localTime');
    expect(applyEvent(start(), { type: 'back' }, limits)).toEqual({
      ok: false,
      error: 'NOT_APPLICABLE',
    });
  });

  it('rejects invalid values and events for the wrong step', () => {
    const atPrompt = run(start(), { type: 'text', text: 'N' });
    const cases: [DraftShape, DraftEvent, string][] = [
      [start(), { type: 'text', text: '   ' }, 'NAME_EMPTY'],
      [start(), { type: 'text', text: 'я'.repeat(101) }, 'NAME_TOO_LONG'],
      [start(), { type: 'text', text: 'a\nb' }, 'NAME_MULTILINE'],
      [start(), { type: 'keep' }, 'NOTHING_TO_KEEP'],
      [start(), { type: 'kind', kind: 'DAILY' }, 'NOT_APPLICABLE'],
      [atPrompt, { type: 'text', text: 'x'.repeat(51) }, 'PROMPT_TOO_LONG'],
      [{ ...atPrompt, step: 'SCHEDULE_KIND' }, { type: 'text', text: 'daily' }, 'NEEDS_BUTTON'],
      [{ ...atPrompt, step: 'WEEKDAY' }, { type: 'weekday', weekday: 8 }, 'NOT_APPLICABLE'],
      [{ ...atPrompt, step: 'LOCAL_TIME' }, { type: 'text', text: '24:00' }, 'TIME_INVALID'],
      [{ ...atPrompt, step: 'TIME_ZONE' }, { type: 'text', text: 'EST' }, 'ZONE_INVALID'],
      [{ ...atPrompt, step: 'PREVIEW' }, { type: 'text', text: 'save' }, 'NEEDS_BUTTON'],
    ];
    for (const [shape, event, error] of cases) {
      expect(applyEvent(shape, event, limits)).toEqual({ ok: false, error });
    }
  });

  it('limits editing to the chosen section', () => {
    const data = { suggestedTimeZone: 'UTC', scheduleKind: 'DAILY' as const };
    expect(stepSequence({ mode: 'EDIT', section: 'NAME', data })).toEqual(['NAME', 'PREVIEW']);
    expect(stepSequence({ mode: 'EDIT', section: 'SCHEDULE', data })).toEqual([
      'SCHEDULE_KIND',
      'LOCAL_TIME',
      'TIME_ZONE',
      'PREVIEW',
    ]);
  });

  it('refuses to complete a tampered or partial configuration', () => {
    const base = { suggestedTimeZone: 'UTC', name: 'N', prompt: 'P', timeZone: 'UTC' };
    expect(
      completeConfiguration({ ...base, scheduleKind: 'WEEKLY', localTime: '09:00' }, limits),
    ).toBeNull();
    expect(
      completeConfiguration({ ...base, scheduleKind: 'DAILY', localTime: '9am' }, limits),
    ).toBeNull();
    expect(completeConfiguration({ ...base, scheduleKind: 'DAILY' }, limits)).toBeNull();
    expect(
      completeConfiguration({ ...base, timeZone: 'EST', scheduleKind: 'MANUAL' }, limits),
    ).toBeNull();
    // A manual schedule never keeps a stale time or weekday.
    expect(
      completeConfiguration(
        { ...base, scheduleKind: 'MANUAL', weekday: 2, localTime: '09:00' },
        limits,
      ),
    ).toMatchObject({ weekday: null, localTime: null });
  });
});

describe('task validation', () => {
  it('normalises and bounds field values', () => {
    expect(validateName(` ${'я'.repeat(100)} `)).toEqual({ ok: true, value: 'я'.repeat(100) });
    expect(validatePrompt('  p ', 8000)).toEqual({ ok: true, value: 'p' });
    expect(parseLocalTime('0:00')).toEqual({ ok: true, value: '00:00' });
    expect(parseLocalTime('23:59')).toEqual({ ok: true, value: '23:59' });
    for (const bad of ['24:00', '12:60', '1200', '12:5', 'noon', '-1:00', '12:00:00']) {
      expect(parseLocalTime(bad)).toEqual({ ok: false, error: 'TIME_INVALID' });
    }
    expect(describeSchedule({ scheduleKind: 'WEEKLY', weekday: 7, localTime: '10:00' })).toBe(
      'Щотижня: неділя о 10:00',
    );
  });
});

describe('task callbacks and messages', () => {
  const id = 'abcdef01-2222-4333-8444-555555555555';

  it('round-trips payloads within 64 bytes and rejects forged ones', () => {
    for (const data of [
      draftCallbackData(id, 123456789, 'kw'),
      taskCallbackData(id, 999999999, 'dy'),
      taskListCallbackData(9999),
    ]) {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(parseCallbackData(data)).not.toBeNull();
    }
    expect(parseCallbackData(taskCallbackData(id, 3, 'p'))).toEqual({
      kind: 'task',
      taskId: id,
      revision: 3,
      op: 'p',
    });
    for (const forged of [
      `t:${id}:0:p`,
      `t:${id.toUpperCase()}:1:p`,
      `t:${id}:1:x`,
      `t:${id}:1:p:1002`,
      'd:1:w8',
      'd:01:s',
      'd:1:s;user=2',
      'tl:-1',
    ]) {
      expect(parseCallbackData(forged)).toBeNull();
    }
  });

  it('binds draft buttons to their draft and rejects legacy or malformed draft payloads', () => {
    const data = draftCallbackData(id, 999999999, 'kw');
    expect(data).toBe(`d:${id}:999999999:kw`);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(parseCallbackData(draftCallbackData(id, 4, 's'))).toEqual({
      kind: 'draft',
      draftId: id,
      version: 4,
      op: 's',
    });
    for (const rejected of [
      'd:4:s', // legacy version-only form: never applied to the current draft
      'd:0:x',
      `d:${id.toUpperCase()}:4:s`,
      `d:${id.slice(0, -1)}:4:s`,
      `d:${id}0:4:s`,
      `d:${id.replace(/-/g, '')}:4:s`,
      `d:not-a-uuid-at-all-0000000000000000000:4:s`,
      `d:${id}:4`,
      `d:${id}:01:s`,
      `d:${id}:4:s:${id}`,
      `d:${id}:4:w8`,
    ]) {
      expect(parseCallbackData(rejected)).toBeNull();
    }
    expect(() => draftCallbackData('not-a-uuid', 1, 's')).toThrow();
  });

  it('escapes user text and splits long previews without breaking entities', () => {
    const prompt = `<b>&${'я'.repeat(4000)}👍🏽`;
    const view = previewView({
      ...start(),
      id,
      step: 'PREVIEW',
      version: 1,
      data: {
        suggestedTimeZone: 'UTC',
        name: '<i>x</i>',
        prompt,
        scheduleKind: 'MANUAL',
        timeZone: 'UTC',
      },
    });
    const parts = htmlParts(view.text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 3800)).toBe(true);
    const joined = parts.join('');
    expect(joined).toContain('&lt;i&gt;x&lt;/i&gt;');
    expect(joined).toContain('&lt;b&gt;&amp;');
    expect(joined).not.toMatch(/<[a-z]/i);
    expect(joined).toContain('👍🏽');
    expect(parts.every((part) => !/&[a-z]*$/.test(part))).toBe(true);
  });

  it('shows the next planned run in the task zone, or why there is none', () => {
    const task = {
      id,
      name: 'N',
      prompt: 'p',
      scheduleKind: 'DAILY' as const,
      weekday: null,
      localTime: '09:00',
      timeZone: 'America/New_York',
      state: 'ACTIVE' as const,
      revision: 1,
      nextRunAt: new Date('2026-11-01T14:00:00Z'),
    };
    expect(taskCardView(task).text).toContain(
      'Наступний запуск: 2026-11-01 09:00 (America/New_York).',
    );
    expect(
      taskCardView({ ...task, scheduleKind: 'MANUAL', localTime: null, nextRunAt: null }).text,
    ).toContain('лише вручну');
    expect(taskCardView({ ...task, state: 'PAUSED', nextRunAt: null }).text).toContain(
      'пропущені не надолужуються',
    );
    for (const card of [taskCardView(task), taskCardView({ ...task, state: 'PAUSED' })]) {
      expect(card.text).not.toContain('ще не працюють');
    }
  });

  it('shows the task zone on cards', () => {
    const card = taskCardView({
      id,
      name: 'N',
      prompt: 'p'.repeat(500),
      scheduleKind: 'DAILY',
      weekday: null,
      localTime: '09:00',
      timeZone: 'America/New_York',
      state: 'PAUSED',
      revision: 4,
    });
    expect(card.text).toContain('Часовий пояс: America/New_York');
    expect(card.text).toContain('Стан: на паузі');
    expect(card.text).not.toMatch(/Наступн/);
    expect(card.text).toContain(`${'p'.repeat(300)}…`);
    const buttons = card.keyboard?.inline_keyboard.flat().map((b) => b.text);
    expect(buttons).toEqual([
      'Назва',
      'Запит',
      'Розклад',
      'Відновити',
      'Видалити',
      'Запустити зараз',
      '« До списку',
    ]);
  });
});

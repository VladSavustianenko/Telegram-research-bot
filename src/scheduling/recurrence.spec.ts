import { afterEach, describe, expect, it } from 'vitest';
import { Temporal } from 'temporal-polyfill';
import {
  MAX_COUNTED_OCCURRENCES,
  formatInZone,
  latestOccurrenceAtOrBefore,
  nextOccurrenceAfter,
  occurrencesBetween,
  resolveLocal,
  type Schedule,
} from './recurrence';

const daily = (localTime: string, timeZone: string): Schedule => ({
  scheduleKind: 'DAILY',
  weekday: null,
  localTime,
  timeZone,
});
const weekly = (weekday: number, localTime: string, timeZone: string): Schedule => ({
  scheduleKind: 'WEEKLY',
  weekday,
  localTime,
  timeZone,
});
const at = (value: string) => new Date(value);
const iso = (date: Date | null) => date?.toISOString() ?? null;
/** Consecutive occurrences after an instant. */
function series(schedule: Schedule, after: string, n: number): string[] {
  const result: string[] = [];
  let current = at(after);
  for (let i = 0; i < n; i += 1) {
    const next = nextOccurrenceAfter(schedule, current);
    if (!next) break;
    result.push(next.toISOString());
    current = next;
  }
  return result;
}

describe('DST policy (resolveLocal)', () => {
  const date = (value: string) => Temporal.PlainDate.from(value);

  it('resolves a gap to the first valid local time after it, not shifted by the gap length', () => {
    // New York, 2026-03-08: 02:00 → 03:00. 02:30 does not exist: 03:00 EDT, not 03:30.
    expect(iso(resolveLocal(date('2026-03-08'), '02:30', 'America/New_York'))).toBe(
      '2026-03-08T07:00:00.000Z',
    );
    // Kyiv, 2026-03-29: 03:00 → 04:00. 03:30 → 04:00 EEST.
    expect(iso(resolveLocal(date('2026-03-29'), '03:30', 'Europe/Kyiv'))).toBe(
      '2026-03-29T01:00:00.000Z',
    );
    // Lord Howe Island shifts by 30 minutes (02:00 → 02:30 on 2026-10-04).
    expect(iso(resolveLocal(date('2026-10-04'), '02:10', 'Australia/Lord_Howe'))).toBe(
      '2026-10-03T15:30:00.000Z',
    );
  });

  it('resolves an overlap to the earlier instant only', () => {
    // New York, 2026-11-01: 01:30 happens at EDT (05:30Z) and EST (06:30Z).
    expect(iso(resolveLocal(date('2026-11-01'), '01:30', 'America/New_York'))).toBe(
      '2026-11-01T05:30:00.000Z',
    );
    // Kyiv, 2026-10-25: 03:30 happens at +03:00 (00:30Z) and +02:00 (01:30Z).
    expect(iso(resolveLocal(date('2026-10-25'), '03:30', 'Europe/Kyiv'))).toBe(
      '2026-10-25T00:30:00.000Z',
    );
  });

  it('keeps an unaffected time on a transition day unchanged', () => {
    expect(iso(resolveLocal(date('2026-03-29'), '09:00', 'Europe/Kyiv'))).toBe(
      '2026-03-29T06:00:00.000Z',
    );
  });
});

describe('daily and weekly occurrences', () => {
  it('runs daily at local 09:00 in Kyiv across both DST transitions', () => {
    expect(series(daily('09:00', 'Europe/Kyiv'), '2026-03-27T12:00:00Z', 3)).toEqual([
      '2026-03-28T07:00:00.000Z', // +02:00
      '2026-03-29T06:00:00.000Z', // +03:00 from the transition day on
      '2026-03-30T06:00:00.000Z',
    ]);
    expect(series(daily('09:00', 'Europe/Kyiv'), '2026-10-24T12:00:00Z', 2)).toEqual([
      '2026-10-25T07:00:00.000Z', // back to +02:00
      '2026-10-26T07:00:00.000Z',
    ]);
  });

  it('returns to the configured local time after a gap and runs once in an overlap', () => {
    expect(series(daily('02:30', 'America/New_York'), '2026-03-06T12:00:00Z', 3)).toEqual([
      '2026-03-07T07:30:00.000Z', // 02:30 EST
      '2026-03-08T07:00:00.000Z', // gap: 03:00 EDT
      '2026-03-09T06:30:00.000Z', // 02:30 EDT again
    ]);
    expect(series(daily('01:30', 'America/New_York'), '2026-10-31T12:00:00Z', 2)).toEqual([
      '2026-11-01T05:30:00.000Z', // earlier 01:30 only
      '2026-11-02T06:30:00.000Z', // 01:30 EST
    ]);
  });

  it('runs weekly on the configured weekday and local time', () => {
    // Sunday 03:30 in Kyiv: the gap Sunday gives 04:00, the next Sunday 03:30 again.
    expect(series(weekly(7, '03:30', 'Europe/Kyiv'), '2026-03-20T00:00:00Z', 3)).toEqual([
      '2026-03-22T01:30:00.000Z',
      '2026-03-29T01:00:00.000Z',
      '2026-04-05T00:30:00.000Z',
    ]);
    // Monday 10:00 in New York, across the November transition.
    expect(series(weekly(1, '10:00', 'America/New_York'), '2026-10-25T00:00:00Z', 2)).toEqual([
      '2026-10-26T14:00:00.000Z',
      '2026-11-02T15:00:00.000Z',
    ]);
  });

  it('crosses month and year boundaries by calendar date', () => {
    expect(series(daily('23:45', 'Europe/Kyiv'), '2026-12-30T22:00:00Z', 3)).toEqual([
      '2026-12-31T21:45:00.000Z',
      '2027-01-01T21:45:00.000Z',
      '2027-01-02T21:45:00.000Z',
    ]);
    // Kyiv midnight is still the previous UTC day.
    expect(nextOccurrenceAfter(daily('00:15', 'Europe/Kyiv'), at('2026-12-31T21:00:00Z'))).toEqual(
      at('2026-12-31T22:15:00Z'),
    );
    expect(
      nextOccurrenceAfter(weekly(5, '08:00', 'Europe/Kyiv'), at('2027-12-31T12:00:00Z')),
    ).toEqual(at('2028-01-07T06:00:00Z'));
  });

  it('is strictly after the given instant and has no occurrence for manual tasks', () => {
    const schedule = daily('09:00', 'Europe/Kyiv');
    expect(nextOccurrenceAfter(schedule, at('2026-10-20T06:00:00Z'))).toEqual(
      at('2026-10-21T06:00:00Z'),
    );
    expect(latestOccurrenceAtOrBefore(schedule, at('2026-10-20T06:00:00Z'))).toEqual(
      at('2026-10-20T06:00:00Z'),
    );
    const manual: Schedule = {
      scheduleKind: 'MANUAL',
      weekday: null,
      localTime: null,
      timeZone: 'UTC',
    };
    expect(nextOccurrenceAfter(manual, at('2026-10-20T06:00:00Z'))).toBeNull();
  });

  it('counts missed occurrences, bounded for very long outages', () => {
    const schedule = daily('09:00', 'Europe/Kyiv');
    expect(
      occurrencesBetween(schedule, at('2026-10-10T06:00:00Z'), at('2026-10-20T06:00:00Z')),
    ).toEqual({ count: 10, last: at('2026-10-19T06:00:00Z') });
    const long = occurrencesBetween(
      schedule,
      at('2020-01-01T07:00:00Z'),
      at('2026-10-20T06:00:00Z'),
    );
    expect(long).toEqual({ count: null, last: at('2026-10-19T06:00:00Z') });
    expect(MAX_COUNTED_OCCURRENCES).toBe(1_000);
  });
});

describe('host time zone independence', () => {
  const saved = process.env['TZ'];
  afterEach(() => {
    if (saved === undefined) delete process.env['TZ'];
    else process.env['TZ'] = saved;
  });

  it.each(['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles'])(
    'gives the same instants with host TZ=%s',
    (zone) => {
      process.env['TZ'] = zone;
      expect(series(daily('02:30', 'America/New_York'), '2026-03-06T12:00:00Z', 3)).toEqual([
        '2026-03-07T07:30:00.000Z',
        '2026-03-08T07:00:00.000Z',
        '2026-03-09T06:30:00.000Z',
      ]);
      expect(formatInZone(at('2026-03-29T01:00:00Z'), 'Europe/Kyiv')).toBe('2026-03-29 04:00');
    },
  );
});

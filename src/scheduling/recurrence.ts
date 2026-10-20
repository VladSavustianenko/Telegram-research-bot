import { Temporal } from 'temporal-polyfill';

/**
 * Recurrence of daily and weekly tasks (TRB-070, SPEC §4, docs/SCHEDULING.md).
 *
 * A schedule is local intent: a wall-clock time (and an ISO weekday for
 * weekly tasks) in the task's IANA zone. Occurrences are computed per local
 * calendar date from that original time; nothing adds 24 or 168 hours. Time
 * zone rules come from the runtime's IANA database through Temporal
 * (temporal-polyfill 1.0.5, which uses Intl).
 *
 * DST policy, applied explicitly because no Temporal disambiguation mode
 * matches it (checked against the library):
 * - a nonexistent local time (gap) resolves to the first valid local time
 *   after the gap, i.e. the transition instant. Kyiv's 03:30 on 2026-03-29
 *   (clocks jump 03:00 → 04:00) gives 04:00 +03:00; "compatible" would give
 *   04:30 and "earlier" 02:30;
 * - an ambiguous local time (overlap) resolves to the earlier instant only
 *   ("earlier"), so it runs once.
 */
export interface Schedule {
  scheduleKind: 'MANUAL' | 'DAILY' | 'WEEKLY';
  /** ISO weekday 1 (Monday) … 7 (Sunday); WEEKLY only. */
  weekday: number | null;
  /** "HH:mm"; DAILY and WEEKLY only. */
  localTime: string | null;
  timeZone: string;
}

/** Upper bound of occurrences counted in one missed range (a long outage stays bounded work). */
export const MAX_COUNTED_OCCURRENCES = 1_000;

const instantOf = (zoned: Temporal.ZonedDateTime) => new Date(zoned.epochMilliseconds);

/** The instant of a local date and time in a zone, under the DST policy above. */
export function resolveLocal(date: Temporal.PlainDate, time: string, timeZone: string): Date {
  const local = date.toPlainDateTime(Temporal.PlainTime.from(time));
  const earlier = local.toZonedDateTime(timeZone, { disambiguation: 'earlier' });
  if (Temporal.PlainDateTime.compare(earlier.toPlainDateTime(), local) === 0) {
    return instantOf(earlier); // valid, or the earlier of two (overlap)
  }
  // Gap: "earlier" lies before the gap; the next transition is where the gap ends.
  const transition = earlier.getTimeZoneTransition('next');
  if (!transition) throw new Error('time zone gap without a transition');
  return instantOf(transition);
}

/** The occurrence on a local date, or null when the schedule does not run that day. */
function occurrenceOn(schedule: Schedule, date: Temporal.PlainDate): Date | null {
  if (schedule.scheduleKind === 'MANUAL' || !schedule.localTime) return null;
  if (schedule.scheduleKind === 'WEEKLY' && date.dayOfWeek !== schedule.weekday) return null;
  return resolveLocal(date, schedule.localTime, schedule.timeZone);
}

function localDate(instant: Date, timeZone: string): Temporal.PlainDate {
  return Temporal.Instant.fromEpochMilliseconds(instant.getTime())
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();
}

/** The first occurrence strictly after `instant`; null for manual tasks. */
export function nextOccurrenceAfter(schedule: Schedule, instant: Date): Date | null {
  if (schedule.scheduleKind === 'MANUAL') return null;
  // One day back covers occurrences whose local date precedes the instant's date in the zone.
  let date = localDate(instant, schedule.timeZone).subtract({ days: 1 });
  for (let i = 0; i < 16; i += 1, date = date.add({ days: 1 })) {
    const occurrence = occurrenceOn(schedule, date);
    if (occurrence && occurrence.getTime() > instant.getTime()) return occurrence;
  }
  throw new Error('no occurrence within 16 days');
}

/** The latest occurrence at or before `instant`; null for manual tasks. */
export function latestOccurrenceAtOrBefore(schedule: Schedule, instant: Date): Date | null {
  if (schedule.scheduleKind === 'MANUAL') return null;
  let date = localDate(instant, schedule.timeZone).add({ days: 1 });
  for (let i = 0; i < 16; i += 1, date = date.subtract({ days: 1 })) {
    const occurrence = occurrenceOn(schedule, date);
    if (occurrence && occurrence.getTime() <= instant.getTime()) return occurrence;
  }
  throw new Error('no occurrence within 16 days');
}

/**
 * Occurrences in [from, until): their number (null beyond
 * MAX_COUNTED_OCCURRENCES) and the last one. `from` is an occurrence.
 */
export function occurrencesBetween(
  schedule: Schedule,
  from: Date,
  until: Date,
): { count: number | null; last: Date | null } {
  let count = 0;
  let last: Date | null = null;
  let current: Date | null = from;
  while (current && current.getTime() < until.getTime()) {
    count += 1;
    last = current;
    if (count >= MAX_COUNTED_OCCURRENCES) {
      // Beyond the bound only the last occurrence matters; it is computed directly.
      const final = latestOccurrenceAtOrBefore(schedule, new Date(until.getTime() - 1));
      return { count: null, last: final };
    }
    current = nextOccurrenceAfter(schedule, current);
  }
  return { count, last };
}

/** "YYYY-MM-DD HH:mm" in the zone, for display. */
export function formatInZone(instant: Date, timeZone: string): string {
  const zoned = Temporal.Instant.fromEpochMilliseconds(instant.getTime()).toZonedDateTimeISO(
    timeZone,
  );
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${zoned.year}-${pad(zoned.month)}-${pad(zoned.day)} ${pad(zoned.hour)}:${pad(zoned.minute)}`;
}

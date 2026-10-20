# TRB-070: persistent scheduling and time semantics

How daily and weekly tasks run on their own. Execution reuses TRB-050 admission and the TRB-060 queue unchanged. The scheduler never calls the provider.

## Schedules and occurrences

- **Kinds.**
  - **Daily** runs once per local date at `HH:mm`.
  - **Weekly** runs once on the configured ISO weekday at `HH:mm`.
  - **Manual-only** tasks have no next occurrence; they run only through "Запустити зараз".
- **Storage.** A task stores its local intent: kind, weekday, `HH:mm` and its own IANA zone. It also stores `next_run_at`, the next planned occurrence as a UTC instant. Only active daily or weekly tasks have one (database check `task_next_run_scheduled`).
- **Computation** (`src/scheduling/recurrence.ts`): each local calendar date in the task's zone, from the original configured time. Fixed 24- or 168-hour steps are never added, and no offset is hard-coded.
  - **Library.** Zone rules come from the runtime's IANA data through Temporal (`temporal-polyfill@1.0.5`, an implementation of the TC39 Temporal API backed by `Intl`), pinned exactly.
  - **Advancing.** The schedule advances from the planned local occurrence: the next `next_run_at` is the first occurrence after the scheduler's current time, never derived from execution or completion time.

### DST policy (SPEC §4)

Temporal's built-in disambiguation modes do not implement the SPEC gap rule. Checked against the library: for Kyiv 03:30 on 2026-03-29, `compatible` gives 04:30 and `earlier` gives 02:30. The resolution is therefore explicit:

| Case | Rule | Example |
|---|---|---|
| Nonexistent local time (gap) | The first valid local time after the gap: the transition instant | New York 2026-03-08 02:30 → 03:00 EDT (07:00Z), not 03:30. Kyiv 2026-03-29 03:30 → 04:00 EEST (01:00Z). Lord Howe 2026-10-04 02:10 → 02:30 (30-minute shift) |
| Ambiguous local time (overlap) | The earlier instant only; runs once | New York 2026-11-01 01:30 → 05:30Z (EDT); the later 01:30 EST is not an occurrence |
| Following days | Back to the configured local time | Daily 02:30 New York: 03-07 07:30Z, 03-08 07:00Z (gap), 03-09 06:30Z |

Results do not depend on the host time zone: tests run the same calculations with `TZ` set to UTC, Pacific/Kiritimati and America/Los_Angeles.

## Scheduler

`SchedulerService` runs with `BACKGROUND_WORKERS=on` and research enabled (`fake` or `live`), like the research worker. Every `SCHEDULER_POLL_INTERVAL_SECONDS` (default 30, the ARCHITECTURE proposal) it does a pass. "Now" is the injected clock.

1. **Initialization.** Active daily or weekly tasks without `next_run_at`, which are tasks from before this feature, get the first occurrence after now (see "Rollout").
2. **Due tasks.** A bounded batch of 20 due tasks, `next_run_at <= now`, oldest first. Each is handled in its own transaction with this lock order:
   1. the owner's identity advisory lock;
   2. the user row (`FOR UPDATE`);
   3. the task row.

   The order is the inbox's, admission's and suspension's: user before task, never task before user.
3. **Revalidation under the locks.** The task must still be active and scheduled, with the same revision and the same `next_run_at` it was selected for, and still due. Otherwise the candidate is stale: a concurrent edit, pause, resume or deletion, or another scheduler instance, already won. Nothing is written.
4. **Disposition.** Only the latest due occurrence is considered; earlier ones are missed:

| Situation | Record (`schedule_event`) | Research |
|---|---|---|
| Earlier missed occurrences (downtime) | One `SKIPPED_MISSED` `SUPERSEDED_BY_LATER_OCCURRENCE` range: first occurrence, `range_end`, `skipped_count` (null beyond 1 000) | None |
| Latest occurrence older than 24 h | `SKIPPED_MISSED` `CATCH_UP_WINDOW_EXCEEDED` | None |
| Owner has no private chat | `SKIPPED_DENIED` `NO_PRIVATE_CHAT` | None |
| Admission accepts it | `ADMITTED` with `run_id`, `catch_up` when more than 5 min late, `lateness_seconds` | One run (trigger `SCHEDULED`, `occurrence_at`), reservation, outbox event, all through normal admission |
| The task has a QUEUED or RUNNING run (manual or scheduled) | `SKIPPED_OVERLAP` `TASK_RUN_ACTIVE`, referencing that run | None; the active run is not reused as this occurrence and nothing is deferred |
| Admission refuses it | `SKIPPED_DENIED` with admission's reason: quota, budget, live configuration, live gate, queue full, access | None |

5. **Advance.** In the same transaction, `next_run_at` advances to the first occurrence after now, conditional on the values just validated.

**Guarantees:**
- **One record per occurrence.** `schedule_event` is unique per `(task, occurrence_at)`, and scheduled runs are unique per `(task, occurrence_at)` (`research_run_scheduled_occurrence`). The one-active-run-per-task index still applies.
- **Denials advance once.** Every refusal is recorded once and the schedule moves on, so nothing is retried on every pass.
- **Infrastructure failure is not a skip.** A failing transaction rolls back completely: run, reservation, event and advance. The occurrence stays due and is retried on a later pass.
- **Same controls for every occurrence.** On-time and catch-up occurrences use the identical admission call: owner access, live restricted to administrators, quotas (the total daily run quota; the manual-run quota applies only to /research and Run now, enforced in admission by source since the review fix), budgets with reservation, live gate, active-run exclusion.
- **No acknowledgement.** A scheduled run is not acknowledged. Its report, or its failure status, is the message.
- **Bounded work.** Each task costs one transaction per pass, whatever the outage length; counting missed occurrences is capped at 1 000. Intermediate historical occurrences are never admitted.

**Denial notices.** The owner is told about a refused occurrence once per consecutive reason. Further denials for the same reason stay silent (`notified = false`) until something else happens. Suspended users and users without access get no notice. Missed and overlapped occurrences are recorded but not announced.

## Catch-up after downtime

SPEC: at most one catch-up, for the latest missed occurrence, when it is no older than 24 hours (inclusive). Examples from the tests (daily 09:00 Kyiv):
- **Short outage.** Due since Friday 2026-10-16; the scheduler returns Monday 10:00. One range record covers Friday to Sunday (3 occurrences), and Monday 09:00 is admitted as a catch-up (lateness 3 600 s). Next: Tuesday 09:00.
- **Long outage.** Due since 2025-09-01: one range record of 413 occurrences, then the latest is admitted if fresh. A weekly Friday task whose latest occurrence is 3 days old gets a range record (6 occurrences) and `CATCH_UP_WINDOW_EXCEEDED`, with no run. Next: the coming Friday.
- **Boundary.** A latest occurrence exactly 24 h old is admitted; 24 h + 1 min is skipped.

## Task lifecycle

| Action | Schedule | Queued research | Running research |
|---|---|---|---|
| Create (Save) | `next_run_at` = first future occurrence; nothing runs | — | — |
| Pause | `next_run_at` cleared | Cancelled `TASK_PAUSED`, reservation released (TRB-050) | May finish and deliver |
| Resume | First occurrence after now; missed ones are not replayed | — | — |
| Prompt edit | Replaced by the first occurrence of the existing schedule strictly after the edit; a pending past-due occurrence is dropped, never run later with the new prompt (paused and manual tasks keep none) | Cancelled `TASK_EDITED`, released | Keeps its immutable snapshot |
| Schedule edit (kind, day, time, zone) | Recomputed from now (paused tasks stay without one) | Cancelled `TASK_EDITED`, released | Keeps its snapshot |
| Name edit | Unchanged | Unchanged | Unchanged |
| Delete | Cleared; never scheduled again | Cancelled `TASK_DELETED`, released | Continues; delivery suppressed (`TASK_DELETED`, durable) |
| User suspension | Occurrences are `SKIPPED_DENIED` (silent) | Cancelled `USER_SUSPENDED` | Provider cancellation requested; suppressed (TRB-030) |
| Run now | Unchanged | — | — |

Run now remains available for paused tasks under normal admission. An edit or pause racing with the scheduler is serialized by the user lock. Whichever commits second sees the other's result: the scheduler finds a stale candidate, or the edit cancels the run the scheduler just queued and releases its reservation.

## Research time context

A scheduled run stores its planned occurrence (`research_run.occurrence_at`) separately from its actual times (`started_at`, `submitted_at`, `completed_at`). The request is built once, at the first submission, and stored in `request_snapshot.request`. Recovery and polling of a submitted response never rebuild it (TRB-060).

**Context lines** (policy `research-policy-2026-10-20.1`):
- **Actual time.** Current UTC time, current local time and offset in the task zone, and the zone.
- **Calendar boundaries** of the actual execution time:
  - the current week, Monday–Sunday in the task zone;
  - the current month;
  - "previous seven days" and "next seven days" as rolling windows ending or starting now, labelled as distinct from calendar weeks.
- **Scheduled runs:** the planned occurrence (local and UTC) and how many minutes later the run actually started. The actual time is stated as the reference.
- **Manual runs:** the queued time and the delay, as before.
- **No invented period.** An instruction says to use these periods only when the task asks for them, and not to assume a search period the task does not state.

**Report header.** A scheduled report shows "Заплановано на <local planned time>". When the check happened more than 5 minutes later, it adds "виконано із затримкою N хв; дані актуальні на час перевірки, а не на запланований час". The existing "Перевірено" line always gives the actual check time.

## Telegram presentation

- **Task cards** show the next run in the task zone ("Наступний запуск: 2026-10-19 09:00 (Europe/Kyiv)."). A manual task shows "лише вручну". A paused task explains that automatic runs are paused and missed ones are not caught up after resuming.
- **Previews of a scheduled task** explain the local-time, DST, single catch-up (≤ 24 h) and overlap/limits behaviour.
- **Removed:** the TRB-040 note that scheduled runs do not work yet.

## Rollout

Migration `20261020180000_trb_070_scheduling` is additive:
- **Task:** `task.next_run_at`, with a check and a due index.
- **Runs:**
  - `research_run.occurrence_at`;
  - `source_update_id` becomes nullable, because scheduled runs have no Telegram update;
  - a trigger-fields check: manual runs keep `source_update_id`, scheduled runs need a task and an occurrence;
  - the scheduled-occurrence unique index.
- **History:** table `schedule_event` with enum `ScheduleDisposition`.
- **Unchanged:** runs, attempts, reservations, ledger entries, outbox events and deliveries.

**Initialization policy for existing tasks.** The migration computes nothing, because the DST rules live in the application. On its first pass the scheduler gives every active daily or weekly task without `next_run_at` the first occurrence after that moment. No occurrence before scheduling existed is executed, recorded or charged. Paused, manual and deleted tasks stay without one; resuming computes it. The owner's development database has no tasks.

## Defaults and decisions for the owner

| Setting | Default | Note |
|---|---|---|
| `SCHEDULER_POLL_INTERVAL_SECONDS` | 30 | ARCHITECTURE proposal; at most 300 |
| Catch-up window | 24 h | SPEC; constant |
| On-time grace (catch-up flag, delay notice) | 5 min | Informational |
| Batch | 20 tasks per pass | Constant |

**Limitations:**
- Scheduling granularity is the polling interval: a run starts up to `SCHEDULER_POLL_INTERVAL_SECONDS`, plus queue time, after its planned time.
- One run executes at a time globally (TRB-060), so simultaneous occurrences queue behind each other and later ones may report a delay. A full queue (`RESEARCH_QUEUE_LIMIT`) or the active-run limit makes an occurrence `SKIPPED_DENIED`, by policy, not deferred.
- Time zone rules are those of the runtime's ICU data. A zone rule change after `next_run_at` was computed applies from the following occurrence.
- Operational history has no Telegram view yet (TRB-080/090).

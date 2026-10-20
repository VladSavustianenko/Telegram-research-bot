# TRB-040: tasks and durable dialogs

Status: DONE (accepted by the owner on 2026-10-19 after review of commit cf8637b; includes the review fix binding draft buttons to their draft). TRB-050 added "Запустити зараз" to cards and lifecycle effects on queued runs (docs/ACCOUNTING.md). Validated with fake providers, a recording Telegram sender and real PostgreSQL only; nothing here was exercised against the real Telegram API.

**Schedules are configuration only.** Tasks store *what* to research and *when* (local intent):
- **Scheduled runs:** TRB-070; nothing executes schedules yet.
- **"Запустити зараз" (since TRB-050):** admits a manual run of the task through the single admission path, with quotas, budgets, the live restriction and one active run per task (docs/ACCOUNTING.md). It is available for paused tasks and never changes the schedule.
- **Effect of task actions on research.** Saving, editing and resuming a task never creates a research run, job or provider call. Pausing or deleting cancels the task's *queued* run (releasing its reservation), and deleting also suppresses delivery of its results.

Cards and previews say that scheduled runs do not work yet and show no next-run time. `/research` and `/result` keep working unchanged, with their TRB-030 authorization: live research is administrator-only until TRB-050.

## Commands and buttons

Available to active users with completed onboarding (docs/IDENTITY.md), in their own private chat only:
- **Suspended users** get the suspension reply.
- **Senders without an account** get the invitation-required reply.
- **Group updates** are ignored before any lookup.

| Entry | Effect |
|---|---|
| `/tasks` | List of non-deleted tasks, oldest first, 5 per page (`«`/`»`), with counts against the limits. One button per task opens its card; "+ Нове завдання" starts creation. Empty state: "Завдань ще немає." |
| `/new` | Starts the creation dialog. When a draft is already open, nothing is discarded: the bot offers "Продовжити" or "Відкинути й почати нове". |
| `/cancel` | Ends the open draft. A saved task is never changed. Without a draft: "Немає незавершеної чернетки." |
| Task card | Shows name, state (active or paused), schedule, the task's time zone and the prompt (first 300 characters). Buttons: Назва / Запит / Розклад (edit), Пауза or Відновити, Видалити, « До списку. |

Commands are routed before free text. Free text is a field value only while a draft is open at a text step; otherwise it gets the help text.

## Creation and editing dialog

Creation steps: **name → prompt → schedule kind (Вручну / Щодня / Щотижня) → weekday (weekly) → local time (daily, weekly) → time zone → preview → Зберегти**.
- **Manual tasks** skip the weekday and time steps. A time zone is still chosen, because research interprets dates in it.
- **Time zone step.** The button offers the user's confirmed zone for a new task, or the task's own zone when editing. Any valid IANA name can be typed (same validation as onboarding).
- **Preview** shows exactly what Save stores: the full name and prompt, the schedule and the zone. A long prompt is split over several messages, with the buttons on the last one. It also says that saving does not start research.
- **Every step** has "Скасувати"; every step after the first has "« Назад".
  - **Back** keeps the entered values. A text step then shows the current value and offers "Залишити як є".
  - **Changing the schedule kind** clears fields the new kind does not use: weekday for daily and manual, time for manual. The database also forbids them (`task_schedule_fields`).
- **Editing** (card buttons Назва / Запит / Розклад) runs only that section's steps, then a preview of that section.
  - The saved task is unchanged until Save. Cancel or expiry leaves it untouched.
  - Editing records the task's revision when it starts (`base_revision`).
- **Save of a new task** creates exactly one task and deletes the draft in one transaction.
- **Save of an edit** updates the task only `WHERE id AND user_id AND revision = base_revision AND state <> DELETED`, and increments the revision. Otherwise the draft ends with "Завдання змінилося після початку редагування, тому зміни не збережено…" plus the current card, from which editing can start again. A deleted target gives "Завдання більше не існує; редагування скасовано."

## Drafts: persistence, expiry and resumption

- **One draft per user** (`task_draft.user_id` is unique), stored in PostgreSQL, so it survives restarts. It holds: mode (CREATE or EDIT), the target task, the section and base revision (EDIT), the current step, the values entered so far, `version` and `expires_at`.
- **Expiry.** A draft expires 24 hours after its last **successful** change (SPEC §3 proposed default).
  - **What extends it:** each accepted value, button choice, Back, and "Продовжити".
  - **What does not:** rejected input and stale buttons.
  - Expiry is evaluated with database time.
- **An expired draft is never resumed or saved.** The next interaction with it ends it and says so. This applies to text, a draft button, `/new`, or starting an edit:
  - "Чернетку нового завдання прострочено (24 год без змін); нічого не збережено. Почніть знову: /new"
  - "Чернетку редагування прострочено…; завдання не змінено."
- **Abandoned drafts.** An expired draft left untouched stays in the table until the user's next interaction; retention cleanup belongs to TRB-090.
- **Resumption.** `/new` (or a card's edit button) while a draft is open offers to continue it or to discard it explicitly. "Продовжити" re-sends the current step with fresh buttons.

## Revisions and stale actions

- **Tasks.** `task.revision` starts at 1 and is incremented by every change: edit save, pause, resume and delete.
  - Card buttons carry `t:<task id>:<revision>:<op>`.
  - A mutating button whose revision is not current changes nothing and re-sends the current card: "Завдання змінилося; ось його актуальний стан."
  - Every mutation is also a conditional update on the revision, so a stale action cannot overwrite newer data even without the per-user lock.
- **Drafts.** Every stored change increments `task_draft.version`. Draft buttons carry `d:<draft id>:<version>:<op>`, at most 51 bytes.
  - **Identity.** The draft ID binds every draft button, including the conflict dialog's Продовжити and Відкинути, to the draft that issued it. Versions alone are not unique: every new draft starts at version 0.
  - **Checks, in order:**
    1. the user's own draft exists (the lookup is scoped to the authenticated user, so a foreign draft ID never matches);
    2. its ID equals the button's;
    3. only then expiry;
    4. the version;
    5. whether the operation applies to the current step.
  - **Mismatch.** A button of an earlier, replaced or foreign draft gets only the acknowledgement "Ця кнопка застаріла." (`CALLBACK_STALE`). It never changes, deletes, saves or extends the current draft, and does not end it even when it has expired.
  - **Other stale buttons.** A button from an older step or an ended draft also does nothing.
  - **Legacy buttons.** Buttons in the earlier version-only form `d:<version>:<op>` (sent before this fix) are not recognised (`CALLBACK_UNKNOWN`) and are never applied to the current draft. The user starts again with `/new`, `/cancel` or a fresh card.
  - `/cancel` is a command and still targets the user's current draft.
  - Rejected input does not change the version, so the buttons on screen stay valid.
- **Callback data** never contains a user ID, is at most 64 bytes, and is parsed with strict patterns (`src/telegram/callback-data.ts`). The action applies to the presser's own records. A forged weekday (`w8`), an unknown operation or an extra suffix is rejected.
- **Concurrency.** All updates of one user are serialised by the TRB-030 identity lock and the user row lock in the inbox transaction. Conditional updates and unique keys hold even without them:
  - `task.created_from_draft_id` is unique, so one draft can never create two tasks;
  - drafts are unique per user;
  - edits are conditional on the revision.

  Replayed Telegram updates are deduplicated by the existing inbox.

## Pause, resume and delete

- **Pause and resume.** Pause sets `PAUSED`, Resume sets `ACTIVE`; each increments the revision.
  - Pausing a paused task, or resuming an active one, changes nothing ("Завдання вже на паузі." / "…вже активне.").
  - Resume respects the active-task limit.
  - Neither triggers research. Cancelling queued work of a paused task becomes relevant with TRB-070.
- **Delete.**
  1. "Видалити" asks for confirmation; the "Так, видалити" button is bound to the owner, task and revision.
  2. If the task changed after the confirmation was requested, the confirmation does nothing and the current card is shown.
  3. Otherwise the task is **soft-deleted**: state `DELETED`, `deleted_at` set, revision incremented.
- **Deleted tasks** disappear from `/tasks` and cards. Every action on them answers like a nonexistent task. An edit draft targeting one ends safely at its next interaction.
- **Preserved.** Nothing cascades: foreign keys are `RESTRICT`, and research runs, reports, deliveries and audit records are untouched. Purging deleted content is TRB-090 retention.

## Ownership

- **Scoped queries.** Every task query includes `user_id = <authenticated user>` and excludes deleted tasks. A foreign, deleted and nonexistent task ID all get "Завдання не знайдено." and change nothing.
- **Drafts are per user.** A draft button pressed by another user acts on that user's own draft, or on none.
- **Triggers.** One keeps `task.user_id` immutable; another requires an edit draft's task to belong to the draft's user.
- **Access recheck.** The task services recheck account access themselves, in addition to the router.

## Validation and limits

| Field | Rule |
|---|---|
| Name | Trimmed, 1–100 code points, a single line (SPEC proposed limit; database check `task_name_length`) |
| Prompt | Trimmed, 1–`RESEARCH_PROMPT_MAX_CHARS` code points (default 8000, the SPEC proposal) |
| Local time | `H:mm` or `HH:mm`, 00:00–23:59, stored as `HH:mm` (database check). Local wall-clock intent; never converted to UTC |
| Weekday | Button only; ISO 1 (Monday) – 7 (Sunday) (database check) |
| Time zone | IANA region name or `UTC`, validated as in onboarding; abbreviations and offsets are rejected. Stored on the task and independent of the user's default afterwards |
| Active tasks | `TASK_ACTIVE_LIMIT`, default 5 (SPEC proposal). Checked at save and resume |
| Saved (non-deleted) tasks | `TASK_SAVED_LIMIT`, default 20 (SPEC proposal). Checked at `/new` and at save |

All user text is escaped in messages (status deliveries are escaped plain text). Logs contain reason codes only: no names, prompts or draft contents.

## Schema

Migration `20261019185534_trb_040_tasks` adds tables `task` and `task_draft` and enums `TaskState`, `ScheduleKind`, `DraftMode`, `DraftSection` and `DraftStep`. It also adds:
- checks: schedule fields per kind, weekday range, time format, name length, deleted consistency, revision ≥ 1, draft mode fields;
- the owner triggers described above.

Existing tables and rows are not changed.

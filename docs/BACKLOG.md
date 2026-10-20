# Implementation backlog

All tasks: TODO. IDs are project-local. Implement in dependency order. Owner acceptance marks DONE; passing tests alone means ready for review.

## TRB-010 — Project foundation

Depends on: none.

Create NestJS/TypeScript project, compatible pinned dependencies, Prisma setup, local disposable PostgreSQL, environment validation, lint/typecheck/test commands, Docker build and health endpoints. Include .env.example without secrets and CI with no external paid calls.

Acceptance: clean install/build succeeds; documented local startup works; invalid required configuration fails clearly; production secrets are absent; unit and integration test DBs are isolated.

Status: DONE — accepted by the owner on 2026-10-18 after review of commit 548884f95f9818a894c065712696d0dcc7eb5085. Evidence: docs/VALIDATION.md, "TRB-010 evidence" and "TRB-010 review fixes".

## TRB-020 — First research-to-Telegram slice

Depends on: 010.

Implement an administrator-only private-chat prototype command, OpenAI provider adapter with required web search, stored run/result and safe sourced delivery. Initially manual runs only. Fake provider is the default test fixture; paid live execution is an explicit operator action.

Acceptance: one command can produce one persisted report with clickable claim-linked citations; processing does not block webhook acknowledgment; unsupported/missing provider config fails safely; no report is labelled live-tested without a live run. Compare fixtures and a small authorized sample before expanding integration.

Status: DONE — accepted by the owner on 2026-10-19 after review of commit 8e1591a3ea356305b6120920872444bcfcd233da and its recorded live evidence. Evidence: docs/VALIDATION.md, "TRB-020 evidence", "TRB-020 review fixes", "TRB-020 authorized live sample", "TRB-020 tool telemetry follow-up", "TRB-020 diagnostic live run and dashboard evidence" and "TRB-020 acceptance".

Accepted with an open limitation: tool-call metering is UNRESOLVED. Acceptance does not mean that `max_tool_calls` was verified as a cap on billable searches or that any exact spending ceiling exists. The first live run had 4 observed output items and 4 metered web search requests with `max_tool_calls = 3`.

## TRB-030 — Invitations, identity and authorization

Depends on: 010, 020.

Implement single-use invitations, admin bootstrap, user onboarding, zone confirmation, suspension, private-chat restriction, inbox deduplication and owner-scoped access services.

Acceptance: expired/replayed invitations fail; two concurrent redemptions yield one winner; foreign callback IDs cannot expose content or mutate records; non-admin access to admin actions fails; group updates create no research; duplicate Telegram updates do not duplicate actions.

Status: DONE — accepted by the owner on 2026-10-19 after review of commit cce6affda159b732b8702b329af2aad7923e97c2 (implementation 6540e6a and review fixes). Behaviour: docs/IDENTITY.md. Evidence: docs/VALIDATION.md, "TRB-030 evidence", "TRB-030 review fixes" and "TRB-030 acceptance". Mock validation only; no live Telegram or OpenAI check. Live research remains administrator-only until TRB-050 is accepted.

Accepted limitation: the durable-suppression migration does not reconstruct the effects of earlier suspensions that were already reactivated. The owner's database has no historical suspended users or affected deliveries, so no further historical backfill is required for acceptance. The migration is not claimed to handle every historical state.

## TRB-040 — Task CRUD and durable dialogs

Depends on: 030.

Implement /tasks, /new, cards, editable prompts/schedules, pause/resume/delete, /cancel, persisted drafts and task revisions. Configure manual/daily/weekly options without cron input.

Acceptance: full creation/edit flow works with Back/Cancel; restart resumes an unexpired draft; malformed zone/time/input is rejected; stale edit callbacks do not overwrite changes; existing tasks keep their zone when the user default changes; save never launches research implicitly.

Status: DONE — accepted by the owner on 2026-10-19 after review of commit cf8637b4b04eb94e197177acaa858017fa96a78f (implementation ebff202 and the review fix). Behaviour: docs/TASKS.md. Evidence: docs/VALIDATION.md, "TRB-040 evidence" and "TRB-040 review fix". Mock validation only; no live Telegram check. Schedules are stored configuration only; execution is TRB-070.

## TRB-050 — Atomic admission, quotas and cost reservations

Depends on: 030, 040.

Add active-run unique constraint, user/global counters, usage ledger, reservations, versioned pricing and outbox. Implement /usage and bounded run settings.

Acceptance: simultaneous requests cannot exceed active-run/quota/reservation capacity; missing budgets/pricing prevent paid execution; rejected requests create no paid work; retries reserve additional allowance; unknown spend is retained; reservation/settlement replay is idempotent; concurrent users remain isolated.

Acceptance note (owner, 2026-10-19, from the TRB-020 live evidence):
- **No assumed cap.** Budget reservations must not treat `max_tool_calls` as a proven hard cap on billable searches. One live run carried `max_tool_calls = 3` and was metered with 4 web search requests (docs/VALIDATION.md).
- **Explicit policy.** Unknown usage and potential overruns need a documented policy, for example a reservation margin for extra searches, retention of unknown amounts and reconciliation against billing evidence. It must be accepted before live research is opened to members.
- **Until then,** live research stays administrator-only (TRB-030).

Status: DONE — accepted by the owner on 2026-10-20 after review of commit b6933460a1140d2845d725caf23b3643f70ae4c6 (implementation and the partial-usage review fix for 6ddcc3e). Mock validation only: scripted providers (no network), synthetic prices, real PostgreSQL; no live request. Behaviour: docs/ACCOUNTING.md. Evidence: docs/VALIDATION.md, "TRB-050 evidence", "TRB-050 review fix" and "TRB-050 acceptance". The acceptance note above is implemented, as follows:
- reservations do not trust `max_tool_calls`: the search allowance must exceed it;
- observed searches are not treated as billed, and the uncovered allowance stays held;
- unknown cost stays exposed until an explicit operator resolution.

Live research remains administrator-only; opening it to members needs a separate owner decision.

## TRB-060 — Persistent queue execution and recovery

Depends on: 020, 050.

Connect outbox to pg-boss. Implement lease/fencing, research attempts, asynchronous response tracking where supported, bounded retries/deadlines, fair dispatch and restart recovery.

Acceptance: replayed jobs cannot execute a terminal run again; crash after business commit still dispatches; known provider response resumes after restart; unknown submission is not automatically resubmitted; stale workers cannot finalize; partial/incomplete responses are not delivered as complete; suspended/deleted work is suppressed with correct accounting.

Status: DONE — accepted by the owner on 2026-10-20 after review of commit 5d19d297f1bd4b010c0f8b9ab9b52539bf0de98d. Mock validation only: scripted providers (no network), recording Telegram sender, real PostgreSQL and real pg-boss 12.37.0; Docker smoke with the fake provider; no live request or Telegram message. Behaviour: docs/QUEUE.md. Evidence: docs/VALIDATION.md, "TRB-060 evidence" and "TRB-060 acceptance". Carried-forward decisions: `RESEARCH_SUBMISSION_RETRY_LIMIT` stays 0, the queue maximum wait stays 3600 s and the deferred wake-up 15 s.
- **Not exactly-once.** Exactly-once provider execution is not claimed: a submission interrupted before its response ID was saved is UNCERTAIN and never resubmitted.
- **Retries off by default.** Automatic resubmission after a rate-limit refusal is implemented but disabled (`RESEARCH_SUBMISSION_RETRY_LIMIT=0`); enabling it is an owner decision.
- **Rollout.** The old and new execution mechanisms must not overlap (docs/QUEUE.md, "Migration and rollout").

## TRB-070 — Persistent scheduling and time semantics

Depends on: 040, 050, 060.

Implement due-task polling, local occurrence computation, DST policies, single catch-up policy, overlap records and edit/pause/resume semantics.

Acceptance: daily/weekly schedules work in Europe/Kyiv and at least one additional DST zone; gap/overlap behavior matches SPEC; two schedulers create one occurrence; downtime causes at most one eligible catch-up; manual run does not shift future schedule; pause/edit cancels eligible queued jobs and releases reservations; budget denial cannot busy-loop.

Status: READY FOR REVIEW (2026-10-20). Mock validation only: fake clock, scripted providers (no network), recording Telegram sender, real PostgreSQL and pg-boss; Docker smoke with the fake provider; no live request or Telegram message. Behaviour: docs/SCHEDULING.md. Evidence: docs/VALIDATION.md, "TRB-070 evidence". Existing active scheduled tasks are initialized to their next future occurrence, with no historical execution.

## TRB-080 — Reliable result delivery and history

Depends on: 040, 060.

Implement durable chunks, separate delivery queue, citation rendering, Unicode-safe splitting, full-text attachment fallback, paginated history, explicit resend and ambiguous-send policy.

Acceptance: Telegram failure does not invoke OpenAI; confirmed parts are not resent after restart; uncertain sends become UNKNOWN; malicious HTML/URLs cannot alter markup; long Unicode results retain citations; blocked chat pauses automatic research; resend costs no research quota; all history actions enforce ownership.

## TRB-090 — Telegram administration and data lifecycle

Depends on: 030, 050, 080.

Implement invitations, suspension/reactivation, limits, aggregate usage/failure views, audit events and retention cleanup. Make proposed defaults explicit in configuration and docs.

Acceptance: admin operations are authorized and auditable; user suspension prevents new work and pending delivery; no routine admin view reveals user report content; retention clears content on schedule while unresolved accounting survives; reactivation does not release stale reports in bulk.

## TRB-100 — Railway readiness and operational runbook

Depends on: 060, 070, 080, 090.

Prepare deployment configuration, migrations, webhook registration procedure, graceful shutdown, liveness/readiness, logs, backup/restore and rollback instructions. Deployment itself requires the owner's request and secrets.

Acceptance: restart/deployment-overlap recovery demonstrated locally or in authorized staging; no paid calls in health checks; backup restore checked against an isolated DB; runbook explains UNKNOWN states and budget reconciliation; no public rollout is claimed until actually performed.

## TRB-110 — Beta acceptance

Depends on: 100.

Run VALIDATION.md scenarios with two isolated users and operator-authorized bounded live research. Record quality, elapsed time, usage and estimated cost without treating one sample as a guarantee.

Acceptance: tenancy and recovery gates pass; fixtures/news/shopping results are evaluated against sources; source limitations remain explicit; no live test exceeds configured controls; owner selects model, budgets, numeric defaults and retention settings before inviting beta users.

## Deferred

Natural-language task setup with confirmation; Mini App/web UI; groups/channels; payments; BYO API keys; RSS/sports/store adapters; change-only notifications. These require new scope approval and are not prerequisites for TRB-110.

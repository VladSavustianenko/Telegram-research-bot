# TRB-080: reliable result delivery and history

How stored results and messages reach Telegram, how failures and ambiguity are handled, and how users see their run history and request resends. Research execution (docs/QUEUE.md) and scheduling (docs/SCHEDULING.md) are unchanged. Delivery never calls the research provider and never changes a run, quota, reservation or ledger entry.

## Guarantees and their limits

- **Research and delivery are independent.** A report and its delivery parts are committed in the research completion transaction, before anything is sent. A Telegram failure leaves the run `SUCCEEDED` and never triggers research. Delivery retries, history views and resends consume no research quota and create no reservation, ledger entry or research outbox event.
- **No exactly-once delivery.** The application cannot make a Telegram call and a database commit atomic, and Telegram's `sendMessage`/`sendDocument` have no idempotency key. Fencing protects database writes; it cannot undo a send. A part whose outcome cannot be confirmed becomes `UNKNOWN` and is never resent automatically. The trade-off is explicit: a possibly missed message, which the user can resend from history, is preferred to a silent duplicate.
- **Confirmed parts are never resent automatically.** A part is `SENT` only with Telegram's message ID; a later pass skips it, after a restart too.
- **The database decides.** A delivery job only names a delivery to inspect. Eligibility, ownership, suppression and progress are read from PostgreSQL under a lease with a fencing token.

## Components

| Component | Responsibility |
|---|---|
| `createDelivery` (`src/delivery/delivery-records.ts`) | In the caller's business transaction: the delivery, its immutable parts and its first `delivery_event` (unless created suppressed) |
| `DeliveryDispatcher` | Publishes due delivery events to the `delivery-send` pg-boss queue (transactional, as research does); recovery sweep |
| `DeliveryWorker` | pg-boss handler: claims a delivery and sends its parts in order |
| `QueueService` | Owns pg-boss and both queues: `research-execute` (with a research provider) and `delivery-send` (with a Telegram sender) |
| History (`src/delivery/history.ts`) | `/history`, task history, run cards, latest result, resend button |

The TRB-020 delivery loop, which polled the `delivery` table directly, has been removed; pg-boss is the only path to a send.

## Queue and transactional publication

`delivery_event` mirrors the research outbox (docs/QUEUE.md):
- **One pending event per delivery** (partial unique index). A new wake-up merges into it; the earlier time wins.
- **Dispatcher transaction** (batch of 20, `FOR UPDATE SKIP LOCKED`): an event whose delivery is no longer sendable (`SENT`, `UNKNOWN`, `PERMANENT_FAILURE`, `SUPPRESSED`, or `SENDING` under a worker) is cancelled. Otherwise the job is published with the event ID as job ID through pg-boss's Prisma adapter in the same transaction, then `dispatched_at` is set. The job and the acknowledgement commit or roll back together, and a repeated publication of one event is a no-op.
- **Queue options** (`delivery-send`): `standard` policy, job expiry 300 s, 5 handler retries with backoff (infrastructure errors only; a retry only re-inspects), retention as for research. Telegram retries are not pg-boss retries: they are new events with their own `available_at`.
- **Startup.** pg-boss starts when a research provider or a Telegram sender is configured. Locally (`TELEGRAM_MODE=disabled`, `RESEARCH_MODE=disabled`) it is not started, and readiness reports the queue `disabled`. The dispatcher and worker run with `BACKGROUND_WORKERS=on` and a sender.

**Crash windows:**

| Moment of failure | Result |
|---|---|
| Before the business transaction commits | Nothing exists: no delivery, no event |
| After commit, before the dispatcher ran | Event pending; published by the next pass of any process |
| After the job insert, before the dispatcher's commit | Both roll back; published again later |
| Job lost (failed after retries, deleted) | The sweep re-creates an event for a sendable delivery with no pending event and no dispatch in the last 10 minutes |
| Worker dies after claiming, before the next part's send intent | Lease expires (60 s); the sweep returns the delivery to `PENDING` and wakes it. Parts already `SENT` are skipped |
| Worker dies after a part's send intent (`SENDING`), before recording the answer | The sweep marks the part and the delivery `UNKNOWN` (`INTERRUPTED_WHILE_SENDING`); later parts stay unsent |
| Worker frozen beyond its lease while a request is in flight | The same: the part becomes `UNKNOWN`. When the frozen request returns, its fenced write fails and the message ID is only logged |
| Confirmed block answer received, process dies before the refusal commits | Unavoidable window: the answer exists only in memory. The part stays `SENDING`, then becomes `UNKNOWN` by lease recovery; the block is detected again by the next delivery to that chat |
| Refusal committed, failure before its effects commit | The refusal stays recorded on the delivery (`destination_block_reason`, `destination_refused_at`, no `destination_block_applied_at`); the recovery sweep applies it. Nothing is sent again |

## Claim, ordering and leases

- **Claim.** One conditional `UPDATE`: the delivery must be `PENDING`, or `RETRYABLE_FAILURE` with `next_attempt_at` reached, without a suppression decision. It sets `SENDING`, a 60 s lease, `fencing_token + 1` and `attempts + 1`. A duplicate or redelivered job finds the delivery `SENDING`, finished or not yet due and does nothing.
- **Per-chat order.** `delivery.seq` records creation order. A delivery waits while an earlier delivery to the same chat is `PENDING`, `SENDING` or `RETRYABLE_FAILURE`. A finished delivery wakes the next one; a waiting delivery also re-schedules itself at the time the earlier one can proceed (at least 5 s). An acknowledgement therefore precedes its report, and a recovery notice precedes the reply that follows it.
- **Lease vs Telegram calls.** The grammY client times out after 15 s; the lease is renewed before every part (60 s). A live worker is therefore never taken over during a call; a takeover means the worker died or froze.

## States

| Record | States |
|---|---|
| Delivery | `PENDING` → `SENDING` → `SENT` / `RETRYABLE_FAILURE` (→ `SENDING` when due) / `UNKNOWN` / `PERMANENT_FAILURE` / `SUPPRESSED` |
| Part | `PENDING` → `SENDING` (send intent, `send_started_at`) → `SENT` (`telegram_message_id`, `sent_at`) / `UNKNOWN` / `FAILED`; a retryable refusal returns it to `PENDING` with `error_code` |

**Per part, in order:**
1. Shutdown requested → hand-over: the lease is released (`PENDING`) and a wake-up written, in one transaction. If a suppression decision was recorded meanwhile, the delivery becomes `SUPPRESSED` instead (below).
2. Recheck: for run-related deliveries the owner's current account access (`RECIPIENT_SUSPENDED`, `ACCESS_REVOKED`, `OWNER_UNRESOLVED`); for every delivery a confirmed chat block (`CHAT_BLOCKED`). A denial ends the delivery `SUPPRESSED` with a durable decision.
3. Send intent: in one transaction the lease is renewed, `delivery.suppressed_at` is read, and the part is marked `SENDING`. A decision committed earlier stops the delivery here (`SUPPRESSED`); one committed later lets only this part go (the documented one-part race, docs/IDENTITY.md).
4. Telegram call (`sendMessage` with HTML, or `sendDocument`).
5. The outcome is recorded under the fencing token.

`UNKNOWN` and `SUPPRESSED` are final for automatic delivery. Earlier `SENT` parts keep their message IDs.

**Suppression decided while a part was in flight** (review fix). A suspension, task deletion or chat block marks a `SENDING` delivery with `suppressed_at` and its reason code, and leaves it to the worker.
- **Hand-over or confirmed retryable refusal.** The worker leaves `SENDING` with one statement that takes the delivery row lock and reads the decision. With a decision, the delivery becomes `SUPPRESSED` with its reason (`RECIPIENT_SUSPENDED`, `TASK_DELETED`, `CHAT_BLOCKED`) instead of `RETRYABLE_FAILURE` or `PENDING`. Its pending wake-ups are cancelled and the next delivery to the chat is woken.
- **Ambiguous outcome.** It still makes the delivery `UNKNOWN`; a confirmed answer still makes the part `SENT` with its message ID.
- **Order of commits.** Whichever commits first, the other sees it: a suppression committed after the worker's update finds the waiting delivery and suppresses it.
- **Rows stranded before this fix.** A waiting delivery with a decision is made final by the next job for it or by the recovery sweep. Nothing is sent and decisions are never cleared, so reactivation releases nothing.

## Retry classification

The Bot API contract: every response carries `ok`; an unsuccessful request has `ok: false`, `error_code` and `description`, optionally with `parameters.retry_after` ("in case of exceeding flood control, the number of seconds left to wait before the request can be repeated"). grammY raises `GrammyError` only for such a parsed answer, and `HttpError` when no API answer was read.

| Outcome | Established? | Delivery | Retried |
|---|---|---|---|
| `ok: true` with a message | Accepted | Part `SENT` | — |
| 429 (flood control) | Not accepted | `RETRYABLE_FAILURE`; `next_attempt_at` = now + the full `retry_after` | Yes, when due |
| 5xx answered with `ok: false` | Not accepted (the API reported failure) | `RETRYABLE_FAILURE`; backoff 5 s, 10 s, 20 s, … ≤ 300 s | Yes |
| Connection never established (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`) | Not sent: no request bytes left the process | `RETRYABLE_FAILURE`, backoff | Yes |
| 403 "bot was blocked by the user" / "user is deactivated" | Not accepted; the destination is confirmed unavailable | `PERMANENT_FAILURE`; destination block (below) | No |
| Other 4xx (malformed HTML, chat not found, other 403) | Not accepted | `PERMANENT_FAILURE`, part `FAILED` | No |
| Timeout, connection reset, abort, unreadable or non-API answer (e.g. a gateway HTML page), unexpected error | **Ambiguous** | Part and delivery `UNKNOWN`; continuation of a multipart delivery stops | Never automatically |

**Bounds.** At most 5 claims per delivery (`MAX_DELIVERY_ATTEMPTS`); a retryable refusal on the last one ends `PERMANENT_FAILURE` with its code. Retry timing is durable (`next_attempt_at` and the event's `available_at`): no sleep, no busy loop, and a job that arrives early only re-schedules.

**Retry-After policy** (review fix):
- **Valid value.** A whole number of seconds from 1 to 30 days. It is honoured in full: `next_attempt_at` = now + `retry_after`, never shortened. The claim requires `next_attempt_at <= now()`, so no early, duplicate or post-restart job can send before it.
- **Long waits.** A single wake-up is delayed at most 1 h; a later retry time is reached by re-inspection, which only re-schedules.
- **Missing or malformed value** (absent, 0, negative, fractional, not a number). Application backoff: 5 s doubling with the claim count, at most 300 s. Never an immediate retry.
- **Beyond 30 days.** `PERMANENT_FAILURE / TELEGRAM_RETRY_AFTER_TOO_LONG`, rather than sending early or waiting without bound.

Change from TRB-020: a 5xx answer is still retried, because the API reported `ok: false`. Non-JSON answers were already ambiguous. Connection-refused errors used to be ambiguous and are now retried.

## Rendering, citations and the document fallback

- **Escaping.** All user and model text is escaped for Telegram HTML (`&`, `<`, `>`, `"`). The only tags are the renderer's own `<b>`, `<i>`, `<code>` and `<a href>`.
- **Citations.** Only provider `url_citation` annotations that pass `safeSourceUrl` become links: http(s), no credentials, at most 2 048 characters. A link is placed right after the claim it annotates, and a model-written markdown citation span is replaced by it. Rejected annotations produce a visible warning, never a source.
- **Unannotated URLs.** URLs written by the model without an annotation stay plain text and never enter the source list. Telegram clients may still auto-detect a bare URL in message text and make it tappable, and the Bot API has no switch to prevent that. Link previews are disabled.
- **Splitting.** Text splits at paragraph, line, sentence, word, then grapheme boundaries. A grapheme cluster or a link is never split, so every part has balanced markup and every marker keeps its URL. Parts stay at most 3 900 UTF-16 units of HTML, which is at least the parsed length, against Telegram's 4 096 characters after entity parsing.
- **Nothing is cut off.** The TRB-020 truncation at six parts is removed.

**Document fallback.** When a report needs more than `MAX_REPORT_PARTS` (6) messages, it is stored as two parts:
1. a summary message: the report header and a note that the full text follows as a file;
2. a `DOCUMENT` part:
   - **file name** `report-<run id>.txt`: only the UUID, never user or model text;
   - **caption** "Повний звіт (текст UTF-8). Запуск <run id>": fixed text, escaped, far below the 1 024-character caption limit.

**Format** (chosen for simplicity and safety): UTF-8 plain text, LF line endings, no BOM. Plain text needs no escaping and cannot carry markup or active content. It contains:
- the header: title, simulation label when applicable, run ID, actual check time (local and UTC), scheduled time with the delay notice for scheduled runs, outcome and warnings;
- the complete report text, with `[n]` right after each annotated claim;
- "Джерела": `[n] <title> — <validated URL>` for every marker.

**Durability and reproducibility.**
- **Stored in the database.** The exact file text is stored in `delivery_part.file_content`, with `file_name` and a SHA-256 `content_hash` over caption, name and text. No local file is involved, and a send or a resend after a restart uploads exactly these bytes.
- **Re-rendering.** Rendering is deterministic: re-rendering the run's stored report reproduces the same parts (integration test).
- **Immutable.** A trigger rejects any change to a part's payload.
- **Upload limit.** Documents must stay within Telegram's 50 MB multipart limit. The bounded provider output keeps reports far below it, and the renderer refuses larger output instead of sending it.

**Limits checked** against the official Bot API documentation (core.telegram.org/bots/api, read 2026-10-20, no API call):
- `sendMessage` `text`: 1–4 096 characters after entity parsing;
- `sendDocument` `caption`: 0–1 024 characters after entity parsing;
- files sent by multipart upload: 50 MB;
- `callback_data`: 1–64 bytes;
- `retry_after`: as quoted above.

## History and results in Telegram

| Entry point | What it shows |
|---|---|
| `/history` (new command) and "Історія запусків" under `/tasks` | The user's recent runs, standalone `/research` runs included |
| Task card: "Історія" | That task's runs |
| Task card: "Останній результат" | The card of the task's latest successful run, or "no results yet" |
| A number on a history page | The run card |
| Run card: "Надіслати звіт" | Explicit resend (below) |
| `/result <id>` (unchanged command) | Explicit resend, or the run's status when it has no report |

**History line:** planned time for scheduled runs, with the actual start when it began more than 5 min later, otherwise the admission time. Then:
- manual or scheduled;
- the task name, or `/research`;
- research state and outcome: queued, running, succeeded, failed, cancelled, uncertain;
- report delivery state;
- a short usage figure.

**Run card:**
- run ID, the task or the standalone prompt preview, trigger;
- times: planned, admitted, actual start with the delay, completion;
- research state with its failure code (uncertain runs say a billed request may exist, and whether an operator reconciled it) and the outcome;
- report delivery state, with an explicit warning when it is `UNKNOWN`;
- resend count and the latest resend's state;
- usage: estimated amount, unresolved or held amounts, current reservation, operator-confirmed amount, or "simulation, no cost". All are local estimates.

Research completion and delivery are shown as separate lines, with a note that a delivery failure does not change the result.

**Delivery labels:**
- `PENDING`: очікує надсилання;
- `SENDING`: надсилається;
- `SENT`: доставлено;
- `RETRYABLE_FAILURE`: тимчасова помилка, буде повторна спроба;
- `UNKNOWN`: невідомо (могло надійти). Never shown as a failure;
- `PERMANENT_FAILURE`: не доставлено;
- `SUPPRESSED`: не надсилалося, with the reason (доступ призупинено, завдання видалено, чат був недоступний, доступ відкликано).

**Pagination.** Five runs per page, newest first, ordered by `(created_at, id)`. "Старіші »" and "« Новіші" carry a keyset cursor (a run of the current page), so runs added meanwhile never shift or duplicate an open page. A cursor that is no longer visible restarts from the newest page with a notice.

**Callback formats** (`src/telegram/callback-data.ts`). UUIDs are encoded as 22-character base64url, and every button fits in 64 bytes (unit-tested):
- `h:<scope>[:o|n:<run>]`: history; scope is a task ID or `*`;
- `r:<run>:<scope>`: run card;
- `rs:<run>`: resend;
- task operations `lr` (latest result) and `h` (history). These are read-only and show the current state at any revision.

A malformed callback, or an ID that does not decode to exactly 16 canonical bytes, is ignored with the stale-button answer.

**Authorization in the service layer.**
- **Identity and access.** Every function rechecks account access and derives the user from the authenticated update.
- **Owner-scoped queries.** Every query uses `user_id` together with the object ID.
- **No disclosure.** Foreign and nonexistent run IDs both get "Запуск не знайдено."; foreign and deleted tasks both get "Завдання не знайдено.".
- **Deleted tasks.** Runs of deleted tasks are hidden everywhere: history, run cards, latest result, the resend button and `/result`. This follows TASKS.md: actions on deleted tasks answer like a nonexistent task. Before TRB-080, `/result` still resent them; that is now closed.
- **Out of scope.** No administration view or retention cleanup is added (TRB-090).

## Explicit resend

`/result <id>` and the run card button call the same service:
- **Checks.** Current access and ownership.
- **No new work.** The run must be `SUCCEEDED`, otherwise its status is sent. The provider is never called.
- **Separate attempt.** A new `RESEND` delivery is created whose parts are copies of the stored report parts, messages and document alike. It has its own state, attempts and evidence.
- **Nothing earlier changes.** The original run, its accounting, the automatic `REPORT` delivery and its parts (states, message IDs, `UNKNOWN`/`SUPPRESSED` evidence) are left untouched.
- **UNKNOWN original.** The run card explains that the earlier message may already have arrived, and labels the button "Надіслати ще раз (можливий дубль)". `/result` sends that explanation first, then the resend.
- **Duplicate updates.** A replayed Telegram update creates nothing (inbox deduplication by `update_id`).
- **Suspension.** Reactivation never resumes suppressed automatic deliveries; the reactivated user may explicitly resend (docs/IDENTITY.md).

## Blocked private chat

**Detection.** Only Telegram's confirmed answer counts: HTTP 403 with "bot was blocked by the user" or "user is deactivated". Rate limits, 5xx answers, timeouts, other 403s and other errors never mark a chat blocked (integration test).

**Durable decision** (review fix). The refusal is recorded first, in the fenced transaction that ends the delivery `PERMANENT_FAILURE`: `destination_block_reason` and `destination_refused_at` on that delivery. Only the delivery row is written, so no lock is taken out of order. If the lease was lost meanwhile (recovery made the part `UNKNOWN`), the refusal is still recorded on the row as evidence.

**Effects** (`applyRecordedBlock`, one transaction, then `destination_block_applied_at`). Lock order: identity advisory lock, user row, then task, run and delivery rows, the order of the inbox, scheduler, admission and suspension.
- **Retry after a failure.** If applying fails or the process dies, the record stays pending; the recovery sweep and later jobs apply it without sending anything again.
- **Applied once.** Appliers are serialized by the identity lock and recheck `destination_block_applied_at` under it, so replays change nothing: no second release, no second audit event.
- **Later restoration wins.** If the user interacted with the bot in their own private chat after the refusal, the chat demonstrably works: the record is marked applied as superseded and nothing is blocked or paused.
  - **What counts.** Only updates with `telegram_update.private_chat_verified` received after `destination_refused_at`. Ingress sets that marker in the deduplicating transaction, right after the transport checks pass: the sender's own private chat (chat ID equal to the sender ID), a non-bot sender, a supported message or button.
  - **Business answer does not matter.** An onboarding prompt, an access refusal or "unknown command" is still proof that the chat works.
  - **What never counts.** Ignored updates: group or supergroup messages, a chat that is not the sender's, bot senders, unsupported update types. Duplicates of an already recorded `update_id` create no new row and no evidence. Such updates leave the decision pending, and recovery applies it.

The effects:
- **User.** `app_user.chat_blocked_at` and `chat_block_reason` are set.
- **Tasks.** Every `ACTIVE` task becomes `PAUSED` with no next run (revision + 1), so no automatic research starts and nothing resumes by itself.
- **Queued automatic runs.** Queued `SCHEDULED` runs are cancelled (`CHAT_BLOCKED`) through the existing lifecycle: their reservation is released once and their outbox event is cancelled.
- **Suppression.** Queued and running runs get the durable `CHAT_BLOCKED` delivery decision, and every waiting delivery to the chat becomes `SUPPRESSED / CHAT_BLOCKED`.
- **While blocked.** New deliveries to a blocked chat are created `SUPPRESSED` and get no event.
- **Audit.** A `DESTINATION_BLOCKED` audit event records the reason and counts.
- **Kept.** Reports, accounting, attempts and earlier suppression evidence.

**Running research.** It is not cancelled: its provider cost is already committed. It finishes normally, and its report is stored and created `SUPPRESSED` (`CHAT_BLOCKED`), available later from history or `/result`. A manual run still queued, which the user explicitly requested, is not cancelled either. It executes, and its report is likewise stored and suppressed.

**Recovery.** Telegram lets a user write to a bot only after unblocking it, so any private message or button press from that user is the recovery action. In the inbox transaction, before any reply is created:
- the block is cleared and audited (`DESTINATION_RESTORED`);
- a notice says how many tasks are paused and that they must be resumed one by one in `/tasks`;
- missed occurrences and undelivered results are not sent; results are available in `/history`.

Resume uses the existing rule: the next future occurrence, no catch-up. Suppressed deliveries and missed occurrences are never replayed in bulk.

## Schema and migration (`20261020210000_trb_080_delivery_history`)

Additive:
- **New table.** `delivery_event`, with one pending event per delivery and a due index.
- **Delivery.** `delivery.seq` (bigserial; existing rows are numbered in table order) and an index of unfinished deliveries per chat.
- **Parts.** `delivery_part.kind` (`MESSAGE` default, `DOCUMENT`), `file_name`, `file_content`, `send_started_at`, `error_code`. A check ties document fields to the kind, and a trigger keeps payloads immutable.
- **Users.** `app_user.chat_blocked_at`, `chat_block_reason`, with a check.
- **Enums and constraints.** `AuditEventKind` gains `DESTINATION_BLOCKED` and `DESTINATION_RESTORED`. The run suppression-reason check now also allows `CHAT_BLOCKED`.

**Existing records.**
- **Unchanged.** Reports, citations, parts with their payloads, states and Telegram message IDs, and `UNKNOWN`/`SUPPRESSED` evidence. No confirmation is invented: new columns are null and parts are `MESSAGE`.
- **Waiting deliveries.** Each `PENDING` or `RETRYABLE_FAILURE` delivery without a decision gets one event (`MIGRATION_BACKFILL`; a retry keeps its time) and enters the new queue.
- **Legacy SENDING deliveries.** A delivery the old worker held during the upgrade is recovered by the lease sweep. A part in flight becomes `UNKNOWN`; otherwise the delivery returns to `PENDING` and is woken.

**Rollout procedure.** The old and new delivery mechanisms must not overlap. The TRB-020 worker claims `PENDING` deliveries directly, ignores events, per-chat order and document parts, and does not know `CHAT_BLOCKED`.
1. Stop every process of the old version, or set `BACKGROUND_WORKERS=off` on it. Wait at least one delivery lease (60 s), or accept that a delivery it held becomes `UNKNOWN` or `PENDING` by recovery.
2. Apply the migration (`prisma migrate deploy`).
3. Start the new version. pg-boss creates the `delivery-send` queue, and the dispatcher publishes the backfilled events.
4. Check readiness (`checks.queue = up`) and `SELECT count(*) FROM delivery_event WHERE dispatched_at IS NULL AND cancelled_at IS NULL AND available_at <= now()`. It should drain to 0.

**Rollback.** Stop the new version first. The old code ignores the new columns and the events table, but it would send document parts as text messages containing only the caption, and it would ignore chat blocks. Roll back only when no `PENDING` delivery has a `DOCUMENT` part, or suppress such deliveries first.

### Review-fix migration (`20261021090000_trb_080_review_fixes`)

Additive: `delivery.destination_block_reason`, `destination_refused_at`, `destination_block_applied_at`, a check tying them together, and an index of refusals still to apply. Existing rows get nulls; no refusal is invented for earlier `PERMANENT_FAILURE / TELEGRAM_403` deliveries. No rollout step beyond `prisma migrate deploy` before starting the new version.

### Follow-up migration (`20261021120000_trb_080_verified_private_updates`)

Additive: `telegram_update.private_chat_verified` (default false) and an index of verified updates per sender. Existing rows stay unmarked; no historical recovery evidence is invented.

## Defaults and decisions for the owner

All values are proposals.

| Setting | Default | Note |
|---|---|---|
| Delivery lease | 60 s | Constant; the Telegram HTTP timeout is 15 s |
| Claims per delivery | 5 | Then `PERMANENT_FAILURE` |
| Backoff without a valid Retry-After | 5 s doubling, ≤ 300 s | A valid Retry-After (1 s – 30 days) is honoured in full; one wake-up waits at most 1 h |
| Sweep / lost-job threshold | 30 s / 10 min | Constants |
| Report messages before the document fallback | 6 | SPEC §5 proposal |
| History page | 5 runs | Constant |
| `TELEGRAM_API_ROOT` | unset (`https://api.telegram.org`) | New optional variable: a self-hosted Bot API server or a local test double (used by the Docker smoke). The bot token is sent there, so set it only to a trusted endpoint |

**Limitations:**
- **Not exactly-once.** Exactly-once delivery is not claimed. An `UNKNOWN` part may or may not have arrived; only an explicit resend repeats it, and it may duplicate.
- **One-part race.** A suspension, deletion or block committed while a part is in flight cannot stop that part.
- **Head-of-line waiting.** Per-chat order means a delivery waiting for a retry holds back later messages to the same chat, at most until its retry ends: the full Retry-After (up to 30 days), or 5 claims.
- **Auto-linking.** Telegram clients may auto-link bare URLs written by the model; they are not presented as sources.
- **No retention.** Deleted-task content is hidden, not purged; retention is TRB-090.
- **Mock validation only.** Telegram behaviour was validated with a recording sender and scripted errors. No real Telegram message was sent, so the classification relies on the documented contract and grammY's error types.

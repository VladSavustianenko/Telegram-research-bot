# Architecture

## 1. Deployment and modules

Single NestJS process initially: webhook HTTP endpoint, persistent scheduler, research worker, delivery worker and outbox dispatcher. PostgreSQL stores application records and pg-boss queues in separate schemas. Run an always-on Railway service; sleeping services are inappropriate for an in-process scheduler. No local filesystem state is required for durability.

Modules: Identity/Invitations, Bot/Conversations, Tasks, Scheduling, Runs/Research, Delivery, Usage, Administration, Operations. Services depend on narrow interfaces for the clock, research provider, queue and Telegram sender. Prisma owns application migrations; pg-boss owns its internal schema. Pin compatible versions and document migration ordering.

Development may use polling; production uses webhook. Never enable both for the same bot token. Verify Telegram webhook secret header; derive sender identity from the verified update. Acknowledge only after durable receipt, without waiting for research. Deduplicate update_id in an inbox table. Process inbox records asynchronously, serialize conversation changes per user, and make actions safe to replay. Callback acknowledgements are best-effort UX, not a business transaction.

## 2. Data model

All mutable records have createdAt/updatedAt. All instants use timestamptz/UTC. Money uses fixed-point decimal or integer micro-USD, never floating point.

| Entity | Key fields and constraints |
|---|---|
| User | UUID, telegramUserId unique, privateChatId, timeZone, status, destinationState, limits |
| Invitation | tokenHash unique, expiresAt, redeemedBy, redeemedAt, createdBy; atomic single redemption |
| Task | UUID, userId FK, name, prompt, version, state, scheduleKind, weekday?, localTime?, timeZone, nextRunAt?, deletedAt? |
| TaskRun | UUID, taskId/userId, trigger MANUAL/SCHEDULED, occurrenceAt?, taskVersion, immutable snapshot, state, outcome?, providerResponseId?, result/citations?, failureCode? |
| ResearchAttempt | runId, attemptNo unique per run, fencingToken, leaseUntil, requestState, provider ID, usage, estimatedCost, pricingVersion |
| Delivery | runId, destination, kind REPORT/RESEND/STATUS, state; default report unique per run |
| DeliveryPart | deliveryId + ordinal unique, immutable rendered payload/hash, state, telegramMessageId?, attempt metadata |
| BudgetReservation | attempt/run reference, user/global period keys, reserved amount, status, reconciled amount |
| UsageLedger | append-only reservation/settlement/release/correction entries with unique operation keys |
| ConversationState | userId unique, flow/step, draft JSON, version, expiresAt |
| TelegramInbox | updateId unique, sanitized payload needed for handling, status, expiry |
| Outbox | UUID, unique business operation key, type, payload, dispatchedAt? |
| ScheduleEvent | taskId, occurrenceAt, disposition and reason; unique per planned occurrence |

Use SQL migrations for constraints Prisma cannot express. Enforce one active QUEUED/RUNNING TaskRun per task using a partial unique index. Scheduled run uniqueness is (taskId, occurrenceAt) where trigger=SCHEDULED. Manual requests use a stable action/inbox deduplication key. User IDs on child records are derived from the parent; validate consistency transactionally or with suitable composite constraints.

## 3. Atomic admission and scheduling

Admission transaction locks the relevant task and quota/budget records in consistent order. Check identity/status, ownership, task revision, active-run exclusion, limits and remaining reservation capacity. Insert TaskRun snapshot, reservation and outbox record together. Record rejection without creating paid work. Safe retries reuse the admission key.

Scheduler polls due rows (proposed interval: 30 seconds), locks bounded batches using SKIP LOCKED, determines missed/catch-up/overlap disposition, advances nextRunAt and admits eligible work atomically. Every occurrence receives an explicit disposition. Quota-blocked occurrences are skipped with a reason, not immediately retried forever. A notification is coalesced to avoid spam.

The outbox dispatcher publishes to pg-boss with a stable run ID, then marks dispatched. A crash between these steps may publish again; consumers must deduplicate in the database. Never write a business record in Prisma and assume a separate queue send is atomic. Use the outbox even if pg-boss supports transactions unless the exact shared transaction adapter is proven.

## 4. Execution and recovery

Run states: QUEUED → RUNNING → SUCCEEDED / FAILED / CANCELLED. Cancellation before dispatch releases unused reservation. Scheduled skips are ScheduleEvent records, not misleading successful runs. SUCCEEDED carries a content outcome; delivery state remains independent.

Worker atomically claims an eligible run, establishes a lease/fencing token and creates an attempt. Recheck suspension/deletion and queued version validity. Supply bounded output/tool settings supported by the selected model, a wall-clock deadline, and current time context. Do not expose application tools or credentials to the model.

Prefer provider asynchronous/background execution where compatible: persist response ID as soon as received, then poll it. Renew leases while polling. A recovering worker resumes polling the known response rather than submitting a second request. Mark response failures/expiry explicitly. Provider background retention and privacy behavior must be verified and documented during implementation.

If the submit outcome is unknown and no response ID was saved, mark the attempt UNKNOWN and retain its budget reservation. Do not blindly resubmit a potentially billed request. Show an actionable failure; a deliberate new run requires a new reservation. A crash after provider acceptance but before ID persistence cannot be eliminated solely by a database transaction.

Retry only classified retryable failures whose prior execution outcome is known, within a small finite policy and fresh budget checks. Respect Retry-After. Do not retry authentication errors, malformed requests or unsupported model configuration. Distinguish deadline timeout from confirmed provider cancellation.

On completion, validate status/text/citations, then atomically save result, reconcile usage and create delivery/outbox records under the fencing token. A stale worker cannot finalize. A deleted task/suspended user retains accounting but suppresses delivery. Provider evidence is not a guarantee that all factual claims are correct.

## 5. Research request and citation handling

Build the request from a versioned system policy, task prompt snapshot and explicit context (UTC now, local now, task zone, week boundaries, scheduled time, actual time and delay). Current week means Monday–Sunday in the task zone. Explicit next/previous seven-day phrases remain distinct. Keep provider state independent across tasks and users; do not reuse a shared conversation.

Require web search through the supported tool-choice mechanism. Store response annotations, including URL/title and claim offsets. Preserve original text separately from rendered text. Use safe HTML escaping and a deterministic citation renderer; remap offsets before splitting chunks and repeat a citation link if required by a split. Only allow safe http/https source links; no unsafe HTML or arbitrary URI schemes.

Do not assume Structured Outputs and the selected search/model combination work together. Verify compatibility. A typed application envelope can be constructed deterministically around provider text/annotations. When content outcome cannot be proven from a validated supported response contract, default to INCONCLUSIVE rather than add an unplanned second call.

Result checker can prove shape, required citations and execution completion, not truth. Live evaluation assesses actual source quality. Prompt injection in a retrieved page must not change destination, schedule, budget or system rules.

## 6. Delivery

Prepare and store immutable chunks before sending. Use Telegram HTML with escaped text/links. Keep margin below 4096 characters, counting the relevant Telegram entity semantics and Unicode boundaries. Send sequentially; persist each successful message ID immediately. Resume from the first pending part after a known failure. Respect Telegram 429 retry_after and provider rate limits.

States: PENDING, SENDING, SENT, RETRYABLE_FAILURE, UNKNOWN, PERMANENT_FAILURE, SUPPRESSED. A crash/timeout after Telegram may have accepted a send creates UNKNOWN: Telegram sendMessage does not provide a general application idempotency key. Default policy is no blind retry of the ambiguous part. Expose a stored-result resend action and label it a resend; duplicates are possible. Document the tradeoff between missed delivery and duplicates.

An explicit resend creates a new Delivery referencing the same stored report and uses no research budget. Failure to send a result never moves a SUCCEEDED research run back to FAILED. A permanently blocked private chat pauses automatic work, records a destination problem and avoids endless retries.

## 7. Usage controls

Use UTC month/day counters. Reservation includes known maximum model tokens/reasoning exposure and tool calls based on verified API controls/pricing. If a selected API cannot enforce a proposed bound, do not advertise that bound as hard; use a bounded supported configuration before beta launch. Unknown costs remain visible and reserved. Version pricing snapshots so historical estimates are reproducible. Never count both settlement and reservation as actual expense.

Quotas apply to users independently and globally. Dispatcher admits work fairly across users; start with one globally active request and one per user. No user may monopolize repeated queue positions through callback spam. Redelivery consumes Telegram throughput, not research quota.

## 8. Operations

Configuration contract (illustrative variable names, implement validation): DATABASE_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, PUBLIC_BASE_URL, ADMIN_TELEGRAM_IDS, OPENAI_API_KEY, OPENAI_MODEL, USER_MONTHLY_BUDGET_USD, GLOBAL_MONTHLY_BUDGET_USD, RUN_MAX_ESTIMATED_COST_USD, RESEARCH_CONCURRENCY, RUN_DEADLINE_SECONDS, OUTPUT_TOKEN_LIMIT, TOOL_CALL_LIMIT. No real secrets in examples.

Provide /health/live and /health/ready; readiness checks DB/config/worker readiness without a live paid OpenAI call. Structured logs include runId/user internal ID/attempt/latency/error codes, not content or secrets. Observe queue age, scheduler lag, provider failures, delivery unknowns and budget rejections.

Railway: use platform PORT, HTTPS public webhook, internal database connection, migration release step, graceful shutdown, PostgreSQL backup/recovery runbook and retention cleanup. On shutdown stop new claims and preserve recoverable in-flight state. Multi-replica overlap during deployments is expected: database constraints/leases remain mandatory even with one configured replica.

Future worker separation uses the same codebase with explicit process roles, not a rewrite. Durable state remains in PostgreSQL. No automatic public deployment is part of this documentation delivery.

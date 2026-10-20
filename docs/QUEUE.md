# TRB-060: persistent queue execution and recovery

How admitted research reaches the provider, survives crashes and restarts, and stays accounted for. TRB-050 records (runs, reservations, ledger, outbox events) remain authoritative. pg-boss only carries wake-up requests.

Out of scope here: recurring scheduling (TRB-070, docs/SCHEDULING.md: scheduled runs enter this path through admission and the outbox like manual runs), the separate delivery queue (TRB-080), administration UI (TRB-090) and deployment (TRB-100).

## Guarantees and their limits

- **No exactly-once provider execution.** The application guarantees at most one *intentional* submission per attempt, and only after a durable submission intent. It cannot make an HTTP call and a database commit atomic. If a process dies after the provider accepted a request but before its response ID was saved, the request exists without a record. That case is recorded as `UNCERTAIN` (`SUBMISSION_INTERRUPTED`), its reservation stays held, live work is blocked until an operator reconciles it, and it is never resubmitted automatically.
- **Duplicate queue delivery is tolerated.** A job is a request to inspect a run, never permission to submit. Every decision is rechecked in the database under row locks and fencing tokens. A duplicate, late or redelivered job finds the run finished, leased by a live worker or already submitted, and does nothing.
- **Business and financial evidence never lives only in pg-boss.** Deleting jobs, queue retention or a lost queue cannot erase runs, attempts, reservations, ledger entries or response IDs, and the recovery sweep re-creates any wake-up that matters.

## Components

| Component | Responsibility |
|---|---|
| Admission (TRB-050, unchanged) | One transaction: run with immutable snapshot, reservation for attempt 1, `RESERVE` ledger entry, `RESEARCH_EXECUTE` outbox event, acknowledgement |
| `OutboxDispatcher` | Publishes due outbox events to pg-boss; recovery sweep |
| `QueueService` | Owns the pg-boss instance, its schema and the `research-execute` queue |
| `ResearchWorker` | pg-boss handler: inspects a run, claims or takes it over, executes it with the existing provider logic |
| Delivery worker | Sends stored deliveries; never calls the provider. Since TRB-080 it consumes its own pg-boss queue, `delivery-send` (docs/DELIVERY.md) |

There is exactly one path to a provider submission: pg-boss job → `ResearchWorker.handle` → database claim. The TRB-050 in-process claim loop, which consumed outbox events directly, has been removed.

## pg-boss

- **Version.** `pg-boss@12.37.0` (published 2026-10-05, pinned exactly). Its engines field requires Node ≥ 22.12, and it depends on `pg ^8.23.1`, which matches the project's `pg@8.23.1`. The package is ESM-only; the CommonJS build loads it through Node 24's `require(esm)` (verified with the compiled output). The API was read from the installed type definitions and SQL plans.
- **Schema.** pg-boss owns its own schema, `QUEUE_SCHEMA` (default `pgboss`; `public` is refused). Prisma migrations never create, alter or inspect it. Prisma's datasource covers only `public`, so the two never drift into each other.
- **Startup and installation.** When a research provider is configured (`RESEARCH_MODE` is `fake` or `live`), the application starts pg-boss with `migrate: true` and `createSchema: true`. pg-boss creates or migrates its schema under its own advisory lock, so concurrent starts are safe. It then creates the `research-execute` queue, or updates the options of an existing one. Without a provider, pg-boss is not started at all.
- **Order relative to Prisma.** Run `prisma migrate deploy` first (the release step), then start the application. The two schemas are independent, so their order only matters for the application tables the dispatcher reads.
- **Database permissions.** The application role needs `CREATE` on the database to create the schema on first start. Alternatively, an operator creates the schema owned by the application role in advance, and then only ownership of that schema is needed. Afterwards pg-boss needs DDL rights inside its schema for its own migrations and maintenance (indexes, partitions), plus normal DML. No rights on `public` beyond what Prisma already uses.
- **Maintenance.** Job expiry, retry scheduling and retention run only with `BACKGROUND_WORKERS=on` (`supervise: true`). Cron scheduling is off (`schedule: false`); recurring schedules belong to TRB-070. OpenTelemetry instrumentation is disabled.
- **Failed start.** A failed start does not stop the process, as with the lazily connected database. Readiness reports the queue `down`, and start is retried with backoff (1 s doubling to 30 s) until it succeeds or the application shuts down.
- **Tests.** The integration global setup installs the pg-boss schema in each run's disposable database, right after `prisma migrate deploy`. Every test application starts its own pg-boss instance against that database (`TEST_DATABASE_URL` safety checks unchanged), and `resetDatabase` truncates `pgboss.job`. Nothing connects to the development database.

### Queue options (`research-execute`)

| Option | Value | Why |
|---|---|---|
| `policy` | `standard` | A singleton policy (`stately`, `exclusive`) would keep a recovery job unfetchable while a dead worker's job still shows `active`, delaying takeover until that job expires. Duplicates are bounded by the outbox instead, and the database decides. |
| Job ID | outbox event ID | Re-publishing one event is a no-op while its job is retained |
| `expireInSeconds` | 900 | Longer than the maximum run deadline (540 s) plus provider calls; an expired job's redelivery finds a live lease and does nothing |
| `retryLimit` / `retryDelay` / backoff / max | 5 / 10 s / exponential / 300 s | Only for handler failures (database errors). A retry only re-inspects the run. |
| Retention | 14 days queued, 7 days after completion | Jobs are disposable; evidence is in application tables |

## Outbox publication and deduplication

`outbox_event` rows now come in two types:
- `RESEARCH_EXECUTE`: written by admission, one per run. It is the run's admission evidence.
- `RESEARCH_WAKE`: any later wake-up (deferral, retry, recovery, shutdown hand-over).

`available_at` delays publication. A partial unique index allows at most one undispatched event per run, and a new wake-up merges into it with the earlier time winning (`ON CONFLICT … LEAST`).

**Dispatcher transaction** (batch of 20, 15 s bound):
1. Lock due events with `FOR UPDATE … SKIP LOCKED`, so several dispatchers never take the same event.
2. Cancel the event instead of publishing it when its run is already finished (`SUCCEEDED`, `FAILED`, `UNCERTAIN`, `CANCELLED`).
3. Otherwise publish the job, with the event ID as job ID, through pg-boss's own Prisma adapter (`fromPrisma(tx)`) in the same transaction, then set `dispatched_at`.

Publication and acknowledgement therefore commit or roll back together. This is the API's documented use (`send(..., { db })` with the bundled Prisma adapter), and an integration test proves the rollback. Each failure point behaves as follows:

| Failure | Result |
|---|---|
| Crash after admission, before the dispatcher ran | Event pending; published on the next pass (any process) |
| Crash after the job insert, before the acknowledgement committed | Both roll back; the event is published again later |
| Commit outcome unknown (connection lost during `COMMIT`) | Both or neither, never one without the other |
| A second publication of the same event (at-least-once) | Same job ID: pg-boss inserts nothing (`ON CONFLICT DO NOTHING`), returns `null` |
| Two dispatchers at once | `SKIP LOCKED`: each event is published by exactly one of them |
| The run was cancelled after its job was published | The job finds the run `CANCELLED` and does nothing |

Queue deduplication is not the final protection: the claim (`state = 'QUEUED'`, single-running index), the fencing token and the submission state are.

## State mapping

| Record | States | Meaning |
|---|---|---|
| Run (`research_run.state`) | QUEUED → RUNNING → SUCCEEDED / FAILED / UNCERTAIN / CANCELLED | Business state (unchanged). Its submission, response, usage and lease fields describe the **current attempt** (`current_attempt_no`). |
| Attempt (`research_attempt`) | `submission_state` SUBMITTING → SUBMITTED; `outcome` null (open) → PROVIDER_TERMINAL / NOT_ACCEPTED / UNCERTAIN | One provider submission, created with the submission intent before the call. Polling or a queue redelivery resumes the same attempt. |
| Reservation (`budget_reservation`) | one per `(run_id, attempt_no)` | Attempt 1 at admission; a later attempt only through retry authorization |
| Outbox event | pending → dispatched or cancelled | Durable wake-up request |
| pg-boss job | created → active → completed, or retry → failed | Transport only. Job success means the inspection finished, not that research succeeded; a FAILED run is a completed job. |

**Clarified deviation from ARCHITECTURE §2.** ARCHITECTURE lists the lease, estimated cost and pricing version on ResearchAttempt. Here the lease and fencing token stay on the run, because a run has one holder whatever its attempt. Cost, pricing version and policy live on the attempt's reservation (`budget_reservation` with `attempt_no`), which is where TRB-050 already keeps them.

The attempt record mirrors the run's current-attempt fields after every fenced write, in the same transaction: response ID, provider status, model, usage, tool count, failure code. Usage, response ID, telemetry and failure reason therefore stay associated with the attempt that produced them.

## Execution, leases and fencing

For each job, `ResearchWorker.handle(runId)` reads the run and acts on its state:

| Run state | Action |
|---|---|
| Missing or finished | Nothing (duplicate or late job) |
| RUNNING, lease live | Nothing: another worker holds it. Its own job, or the recovery sweep after a crash, covers it. |
| RUNNING, lease expired | Takeover: new lease and `fencing_token + 1` (`SKIP LOCKED`), then the recovery policy below |
| QUEUED | Cancel queued runs without admission evidence or past the maximum wait. Then claim the fairest eligible queued run, which may be a different run than the job's, if capacity allows. Otherwise write a deferred wake-up for this run. |

**Leases and fencing.**
- **Lease.** 60 s (`RUN_LEASE_SECONDS`). It is renewed before every poll and before every submit and cancel call. `OPENAI_HTTP_TIMEOUT_MS` is limited to 30 s, half the lease, so a live worker is never taken over during a provider call.
- **Fencing.** Every write after the claim is conditional on `(id, fencing_token, state = 'RUNNING')`: observations, the attempt record, finalization, settlement, release, delivery creation and wake-ups. A stale worker's first write fails with `StaleLeaseError`, and it stops without having changed anything. A response ID it receives too late is logged for reconciliation.
- **Long provider work vs queue expiry.** If pg-boss expires a job while its worker is still polling, the redelivered job finds the live lease and does nothing. If a worker freezes and its lease lapses, the next job takes over with a higher fencing token, and the frozen worker can no longer finalize.

**Rechecks before a submission**, in one transaction that also records the intent:
- **Owner eligibility**, under a shared lock on the owner's row: suspension, lost access, live research for administrators only.
- **Task deletion.** A pause does not cancel manual runs, per SPEC.
- **Live gate.** No unreconciled live UNCERTAIN run (also enforced at claim).
- **Provider kind** (fake or live) equals the admitted one.
- **Reservation.** The current attempt's reservation must be `RESERVED`.
- **The intent itself.** The immutable request is built once, on the first attempt, and reused unchanged. The attempt row and `submission_state = SUBMITTING` are written before the call; the response ID is saved immediately afterwards.

## Recovery policy

| Situation | Behaviour |
|---|---|
| Work never claimed, or claimed with no submission intent (`NOT_SUBMITTED`) | Executes after the eligibility and reservation checks |
| Submission intent without a response ID (`SUBMITTING`) | `UNCERTAIN / SUBMISSION_INTERRUPTED`; reservation becomes UNRESOLVED (exposure kept); never resubmitted |
| Known response ID (`SUBMITTED`) | Polling of the same response resumes. The deadline stays `submitted_at + RUN_DEADLINE_SECONDS` and is never extended by a queue retry. Bounds are re-verified on every snapshot. |
| Response no longer retrievable (HTTP 404) | `UNCERTAIN / RESPONSE_NOT_RETRIEVABLE`; no replacement submission |
| Cancellation failed or not confirmed terminal | `UNCERTAIN` (unchanged TRB-020 rules) |
| Incomplete, failed or cancelled provider response | `FAILED`, never delivered as a report |
| Graceful shutdown while polling | Lease released and wake-up written in one transaction, so the next process resumes polling at once |
| Shutdown during a provider call | The call is awaited for at most `OPENAI_HTTP_TIMEOUT_MS + 5 s`, so that its response ID can be saved. A process killed earlier leaves `SUBMITTING`, which is recovered as UNCERTAIN. |

## Retry matrix

| # | What is retried | Mechanism | Bound | Paid? |
|---|---|---|---|---|
| 1 | Outbox publication | Dispatcher pass every `WORKER_POLL_INTERVAL_MS`; the event stays pending until it commits | Unbounded but free; each pass is one bounded transaction | No |
| 2 | Queue redelivery and recovery | pg-boss retry after a handler failure; job expiry; recovery sweep every 30 s (expired leases, lost jobs after 10 min) | 5 retries with backoff ≤ 300 s; then the sweep. Every redelivery only re-inspects. | No |
| 3 | Retrieval of a known response | Poll loop until the run deadline; errors other than 404 are retried each `OPENAI_POLL_INTERVAL_MS` | The run deadline (≤ 540 s) | Not billed per poll |
| 4 | A new provider submission | Only after an HTTP 429 that is not `insufficient_quota` on submit, when `RESEARCH_SUBMISSION_RETRY_LIMIT` allows (**default 0, disabled**) | ≤ 2 extra attempts; delay = Retry-After, else `RESEARCH_SUBMISSION_RETRY_DELAY_SECONDS`, within 1–300 s | Yes: each attempt has its own reservation |

**What never triggers a new submission:**
- ambiguous outcomes: timeouts, connection loss, aborts, 5xx, unexpected errors;
- any other 4xx (authentication, malformed request, unsupported configuration);
- an exhausted quota (429 `insufficient_quota`);
- a lost or expired response, or an unconfirmed cancellation.

**Why 429 qualifies.** An HTTP 4xx response is the provider rejecting the request before execution, so no response object exists. TRB-020 already treats it this way and releases the reservation. A 429 rate-limit refusal is the only such case that can succeed later unchanged. The SDK's own retries stay disabled (`maxRetries: 0`), so the application is the only place a resubmission can happen.

**Deferral is durable.** It is an outbox event with `available_at`, never a sleep or a pg-boss retry. A run that could not start is inspected again when its retry delay ends, or after `RESEARCH_CAPACITY_RETRY_SECONDS`. A finishing run wakes the queued runs at once.

**Overall wait is bounded.** A queued run not started within `RESEARCH_QUEUE_MAX_WAIT_SECONDS` of admission (or of its retry becoming due) is cancelled with `QUEUE_WAIT_EXCEEDED`. Its reservation is released once and the owner is told. This also bounds waiting while live work is blocked by an unresolved UNCERTAIN run.

## Accounting for attempts

**Authorizing an additional attempt.** It happens in one fenced transaction, with locks taken in admission order: owner row, then run row, then the admission advisory lock.
1. The refused attempt becomes `NOT_ACCEPTED` and its reservation is released (`RELEASE`).
2. The next attempt is authorized like an admission:
   - owner eligibility;
   - the live gate;
   - user and global monthly budgets: current exposure plus the new reservation must fit, and missing budgets refuse.
3. If authorized, a new reservation is created with the run's accepted pricing snapshot and policy (copied from attempt 1, same UTC period). The run is requeued with `next_attempt_at`, its submission fields are reset for the new attempt, and a wake-up is written.
4. A refusal finishes the run `FAILED` with `<code>;RETRY_REFUSED:<reason>` in the same transaction.

**Rules:**
- **Reservations are never reused.** A settled or released reservation never funds another attempt, and every attempt's evidence and ledger entries are kept.
- **No new reservation without a new submission.** Polling, takeover and redelivery never create one.
- **Settlement stays per attempt and fenced.** It uses the attempt's own reservation, the accepted pricing snapshot and the TRB-050 partial-usage policy. Observed search items are counted for the attempt's own response ID. A stale worker cannot settle or release anything.
- **No automatic zero.** Queue expiry, job failure or exhausted job retries prove nothing about provider cost and never release anything. Only these release a reservation:
  - cancellation before submission (pause, deletion, suspension, maximum queue wait, owner denial);
  - a provider refusal.
- **Quotas count runs.** Daily quotas count runs, not attempts, so a retry does not consume quota. A run cancelled while waiting for a retry is excluded like any run cancelled before submission: its earlier attempt was refused and not billed.

## Lifecycle while work waits

| Event | Queued run (job published or not) | Run waiting for a retry | Running run |
|---|---|---|---|
| Task pause | CANCELLED `TASK_PAUSED`; current reservation released once; pending events cancelled; a later job does nothing | Same (attempt 2 reservation released) | May finish and deliver (SPEC §4) |
| Task deletion | CANCELLED `TASK_DELETED` (same) | Same | Continues; delivery suppressed |
| User suspension | CANCELLED `USER_SUSPENDED` (same) | Same | Provider cancellation requested; tracked and accounted for |
| Operator reconciliation | Queued runs are woken in the reconciliation transaction | — | — |

Durable suppression decisions (TRB-030) are stored on the run and survive restarts and reactivation. Workers recheck them on every poll and when creating deliveries.

## Fair dispatch and capacity

- **Capacity.** Global capacity stays at one RUNNING run, enforced by the `research_run_single_running` unique index across all processes. `RESEARCH_CONCURRENCY` must remain 1. That also bounds each user to one running run; `USER_ACTIVE_RUN_LIMIT` still limits queued plus running runs at admission. Paid concurrency defaults are unchanged.
- **Claim order.**
  - Among eligible queued runs, the user whose most recent run started earliest (or never) goes first, then the oldest run.
  - A user with a backlog therefore cannot starve another: every user with eligible work is served after at most one run of each other user.
  - Eligible means: admission evidence, retry delay elapsed and, for live runs, no unreconciled live UNCERTAIN run.
  - Ineligible runs are skipped, never blocking: simulated work proceeds while live work is blocked.
- **Claim mechanics.** The eligibility check, the capacity check and the claim are one statement under `FOR UPDATE SKIP LOCKED`. The job that triggers it may claim a fairer run than its own, so a wake-up always makes progress when capacity is free.
- **Denied capacity.** A capacity-denied job completes after writing a deferred wake-up; there is no tight loop. When the running run finishes, its finishing transaction wakes the queued runs.

## Startup, shutdown and health

**Startup** (`BACKGROUND_WORKERS=on`):
1. Prisma, which connects lazily.
2. pg-boss start, schema migration and queue creation (`onModuleInit`).
3. Once the queue is up: the outbox dispatcher loop and the pg-boss worker (one job at a time, polling every `WORKER_POLL_INTERVAL_MS`, at least 0.5 s).
4. The delivery worker, as before.

**Shutdown** (SIGTERM/SIGINT):
1. Stop fetching jobs and signal the active handler. A polling handler hands its run over. A provider call is awaited for at most `OPENAI_HTTP_TIMEOUT_MS + 5 s`.
2. Stop the dispatcher loop, then stop pg-boss (graceful, 5 s), then drain the database pool.

Nothing is finalized because of a shutdown. Response IDs and submission states are already durable. No background promise is left unhandled: loops log their errors, and pg-boss `error` events are logged.

**Health:**
- **Liveness** has no dependency checks.
- **Readiness** gains `checks.queue`:
  - `disabled` without a research provider (ready);
  - `up` once pg-boss started;
  - `down` while starting, retrying or stopped (not ready, HTTP 503).

  It reads in-process state only and never contacts OpenAI or Telegram. The JSON contract changed: `checks` now has three fields.

## Migration and rollout

Migration `20261020120000_trb_060_queue_execution` is additive. It rewrites no applied migration.
- **New:** `research_attempt`, `research_run.current_attempt_no` (default 1) and `next_attempt_at`, `budget_reservation.attempt_no` (default 1), `outbox_event.available_at`.
- **Changed:** the unique key `budget_reservation(run_id)` becomes `(run_id, attempt_no)`; the immutable-inputs trigger now includes `attempt_no`.
- **Constraints:** one pending outbox event per run, a type check on outbox events, and positive attempt numbers.

**Backfill and existing records:**
- **Attempts.** Every run that reached submission gets attempt 1, copied from its own fields: response ID, status, model, usage, tool count, times. Its outcome is derived only where the recorded state is unambiguous:
  - `UNCERTAIN` → UNCERTAIN;
  - finished with a response ID → PROVIDER_TERMINAL;
  - `FAILED` while `SUBMITTING` without an ID → NOT_ACCEPTED;
  - anything else stays null.

  Nothing is invented: no response IDs, attempt costs or zero settlements. Runs never submitted get no attempt.
- **Reservations and ledger entries** are unchanged (attempt 1).
- **Pending `RESEARCH_EXECUTE` events** are published by the dispatcher on first start.
- **Events the TRB-050 worker consumed.** It set `dispatched_at` when it claimed a run. If such a run is still RUNNING, its lease expires and the recovery sweep wakes it; recovery then follows the submission state. A finished run is never republished: a wake-up of a finished run is cancelled.
- **Queued runs without admission evidence** (from before TRB-050) are still cancelled (`ADMISSION_EVIDENCE_MISSING`).
- **Runs without an attempt record** (rows written by the old code during an overlap) get one on their first fenced write.
- **The owner's development database** holds three finished TRB-020 runs, no queued or running runs, no reservations and no outbox events; nothing needs cleaning up. See VALIDATION.md for the applied-migration check.

**Rollout procedure.** Old and new execution mechanisms must not overlap. The TRB-050 worker claims QUEUED runs directly and ignores attempts and per-attempt reservations. It also treats a queued run whose execution event is already dispatched as lacking admission evidence: it would cancel such a run (`ADMISSION_EVIDENCE_MISSING`) without releasing its reservation, and every run the new dispatcher has published looks like that.
1. Stop every process running the old version, or set `BACKGROUND_WORKERS=off` on it. Wait until no run is RUNNING with a live lease, or accept that such runs will be recovered under the new rules.
2. Apply the migration (`prisma migrate deploy`).
3. Start the new version. pg-boss installs its schema, the dispatcher publishes pending events, and the sweep wakes runs whose leases expired.
4. Check readiness (`checks.queue = up`) and `SELECT count(*) FROM outbox_event WHERE dispatched_at IS NULL AND cancelled_at IS NULL`, which should drain to 0 with no runs due.

**Rollback.** Stop the new version first. Roll back only when no run is QUEUED or RUNNING. The old worker would cancel published queued runs without releasing their reservations (see above), and it does not know retry delays or attempt reservations. The old code ignores the new columns. Dropping the pg-boss schema is optional; it holds no evidence.

## Operator handling

- **UNCERTAIN runs.** Procedure unchanged (`npm run ops:reconcile -- --list`, docs/RESEARCH_SLICE.md); financial resolution goes through `npm run ops:accounting` (docs/ACCOUNTING.md). Reconciliation now wakes queued runs immediately. Never resubmit an uncertain request manually; a deliberate new `/research` creates a new run with a new reservation.
- **Stuck work.** Inspect the database, not the queue:
  - `SELECT id, state, submission_state, current_attempt_no, lease_until, next_attempt_at FROM research_run WHERE state IN ('QUEUED','RUNNING')`;
  - pending events: `SELECT run_id, type, available_at FROM outbox_event WHERE dispatched_at IS NULL AND cancelled_at IS NULL`;
  - attempts: `SELECT * FROM research_attempt WHERE run_id = …`.

  A RUNNING run with an expired lease is woken by the sweep within 30 s. A queued run without a pending event and without a dispatch in the last 10 minutes is woken again.
- **Failed jobs.** Jobs in `pgboss.job` with state `failed` are handler failures (database errors). They can be deleted; the sweep re-wakes the affected runs. Never delete or edit application rows to "unstick" a run. Never edit `submission_state` or reservations by hand.
- **Never** set `RESEARCH_SUBMISSION_RETRY_LIMIT` above 0 to "repair" uncertain runs: it applies only to future refusals proven not accepted.

## Defaults and decisions for the owner

All values are proposals; none was approved as final.

| Setting | Default | Note |
|---|---|---|
| `QUEUE_SCHEMA` | `pgboss` | Separate schema |
| `RESEARCH_SUBMISSION_RETRY_LIMIT` | 0 | Automatic paid resubmission disabled. Suggestion if enabled: 1. |
| `RESEARCH_SUBMISSION_RETRY_DELAY_SECONDS` | 30 | Used without Retry-After; at most 300 |
| `RESEARCH_CAPACITY_RETRY_SECONDS` | 15 | Re-inspection of a run that could not start |
| `RESEARCH_QUEUE_MAX_WAIT_SECONDS` | 3600 | Maximum queue wait before cancellation with release |
| `OPENAI_HTTP_TIMEOUT_MS` | 30000 | Now limited to ≤ 30000 (half the lease) |
| Run lease / sweep / lost-job threshold | 60 s / 30 s / 10 min | Constants |
| Global / per-user execution | 1 / 1 | Unchanged |

**Limitations:**
- One research request at a time globally; throughput is bounded by run duration.
- The pg-boss worker processes one job at a time per process. A job waiting behind a long run is inspected when capacity frees, or after its deferral.
- Exactly-once external effects are not claimed (see the top of this page).
- Platform drain windows shorter than `OPENAI_HTTP_TIMEOUT_MS + 5 s` can turn an in-flight submission into UNCERTAIN on deploy. Railway settings are TRB-100.

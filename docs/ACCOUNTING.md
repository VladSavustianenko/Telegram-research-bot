# TRB-050: admission, quotas and cost accounting

Status: READY FOR REVIEW. Validated with scripted providers (no network), synthetic prices and real PostgreSQL only. No live request was made; no figure here was checked against an OpenAI invoice.

## What the accounting is, and what it is not

The application keeps **its own conservative accounting** of live research: a reservation before each paid request, a local estimate afterwards, and an explicit unresolved amount whenever cost is unknown. Admission is refused when that accounting would exceed a configured budget.

It is **not** a provider spending ceiling, for these reasons:
- **Tool calls.** `max_tool_calls` is not a proven cap on billable searches. The authorized TRB-020 sample was metered with 4 web search requests at `max_tool_calls = 3` (docs/VALIDATION.md). Observed `web_search_call` items are not an authoritative billable count either.
- **Input tokens.** No API limit exists for input tokens, including retrieved search content. The input allowance below is an assumption, not a bound.
- **Cost of failures.** Deadlines, cancellation and failures do not guarantee that nothing was billed. A request may still run, and a failed or cancelled request may still cost money.
- **Estimates.** These are computed from operator-supplied prices and provider usage reports. They are labelled estimates everywhere; only an operator-entered amount from billing evidence is "confirmed".

For a hard stop at the provider, keep an OpenAI project spend limit with "Enforce a hard limit" enabled (docs/RESEARCH_SLICE.md). Enforcement there also lags.

## Admission (one path)

`src/research/admission.ts` `admitResearch` is the only way to create research. Two entry points use it:
- `/research <prompt>`;
- a task card's "Запустити зараз" (`t:<task>:<revision>:r`).

Both are manual runs (`trigger = MANUAL`). It runs inside the Telegram inbox transaction.

**Lock order:**
1. the sender's identity advisory lock and user row (taken by the inbox, TRB-030);
2. the task row (`FOR UPDATE`, task runs only);
3. the global admission advisory lock.

Suspension, task pause and delete take the user row and then the task row, so the order is consistent.

**Checks, in order.** A rejection writes only a reply: no run, reservation or outbox event.

| # | Check | Rejection reason |
|---|---|---|
| 1 | Task belongs to the sender, is not deleted, and the button's revision is current | `TASK_NOT_FOUND`, `TASK_STALE` |
| 2 | The task already has a QUEUED or RUNNING run: reply with its status. This consumes no quota or reservation | `TASK_RUN_ACTIVE` (not a rejection) |
| 3 | Research enabled; account access; live research only for configured administrators | `RESEARCH_DISABLED`, TRB-030 denials, `LIVE_ADMIN_ONLY` |
| 4 | Global queue (`RESEARCH_QUEUE_LIMIT`, QUEUED + RUNNING) and per-user active runs (`USER_ACTIVE_RUN_LIMIT`) | `QUEUE_FULL`, `USER_ACTIVE_LIMIT` |
| 5 | Daily quotas per user (UTC day): `USER_DAILY_RUN_LIMIT`, `USER_DAILY_MANUAL_RUN_LIMIT` | `DAILY_RUN_LIMIT`, `DAILY_MANUAL_LIMIT` |
| 6 | Live only: no unresolved live UNCERTAIN run (TRB-020 fail-closed gate, unchanged) | `LIVE_BLOCKED_UNCERTAIN` |
| 7 | Live only: complete accounting configuration and a consistent pricing label | `LIVE_ACCOUNTING_<problem>` |
| 8 | Live only: user's and global UTC-month exposure, plus this reservation, within `USER_MONTHLY_BUDGET_USD` and `GLOBAL_MONTHLY_BUDGET_USD` | `USER_BUDGET_EXHAUSTED`, `GLOBAL_BUDGET_EXHAUSTED` |

**Accepted run.** In the same transaction, the admission creates:
- the run, with an immutable snapshot of prompt, zone, model, bounds and context dates. For a task run, the prompt and zone are copied from the task, and the task revision is recorded;
- the admission periods;
- for live runs, the reservation, its `RESERVE` ledger entry and the pricing snapshot;
- one `RESEARCH_EXECUTE` outbox event;
- the acknowledgement.

**Database guarantees:**
- one QUEUED/RUNNING run per task (partial unique index `research_run_one_active_per_task`);
- one execution event per run;
- one reservation per run.

Administrators are subject to the same quotas and budgets; only the live-research restriction distinguishes them.

## Quotas and periods

**UTC.** All accounting periods use UTC (SPEC §6). The user's display or task time zone never affects them.
- **Run periods.** A run stores `admitted_day` (`YYYY-MM-DD`) and `admitted_month` (`YYYY-MM`) from the admission instant. They are never recomputed.
- **Ledger periods.** A reservation and all its ledger entries belong to the run's admission month, even if the run settles after midnight or after the month ends.

| Quota | Counts | Released when |
|---|---|---|
| `USER_DAILY_RUN_LIMIT` (default 10) | Runs admitted on the UTC day, live and simulated | The run is CANCELLED before submission (`submission_state = NOT_SUBMITTED`) |
| `USER_DAILY_MANUAL_RUN_LIMIT` (default 5) | Same, `trigger = MANUAL`. Every run is manual until TRB-070 | Same |
| `USER_ACTIVE_RUN_LIMIT` (default 1) | The user's QUEUED + RUNNING runs | The run leaves QUEUED/RUNNING |
| `RESEARCH_QUEUE_LIMIT` (default 3) | All QUEUED + RUNNING runs | Same |
| `USER_MONTHLY_BUDGET_USD` | Exposure of the user's live runs admitted in the UTC month | See ledger transitions |
| `GLOBAL_MONTHLY_BUDGET_USD` | Exposure of all live runs admitted in the UTC month | Same |

- **Retained counts.** A run that may have reached the provider (SUBMITTING or SUBMITTED, whatever its final state) keeps counting.
- **Simulated runs** (`RESEARCH_MODE=fake`) count towards run quotas but have no reservation and no money.
- **Resends.** `/result` resends a stored report: no quota, reservation or provider call.
- **Task changes.** Creating, editing or pausing a task never admits research.

## Pricing and reservation policy

Operator configuration. All of it is required for live admission; if any part is missing, live requests are refused (`LIVE_ACCOUNTING_*`) and nothing is submitted.

| Variable | Meaning |
|---|---|
| `USER_MONTHLY_BUDGET_USD`, `GLOBAL_MONTHLY_BUDGET_USD` | Budgets per UTC month, against exposure |
| `RUN_MAX_ESTIMATED_COST_USD` | Upper bound for one reservation. A policy reserving more refuses admission |
| `PRICING_VERSION` | Label of the rates. The first admission registers it in `pricing_version` (immutable). Reusing a label with different rates refuses admission (`PRICING_VERSION_CONFLICT`) |
| `PRICING_MODEL` | Model the rates apply to; must equal `OPENAI_MODEL` (otherwise `MODEL_NOT_PRICED`) |
| `PRICING_RETURNED_MODELS` | Model identifiers the provider may return for it: exact names or `prefix*` (for example `gpt-5.5-*`). Settlement with any other returned model is unresolved |
| `OPENAI_PRICE_INPUT_PER_MTOK_USD`, `OPENAI_PRICE_CACHED_INPUT_PER_MTOK_USD`, `OPENAI_PRICE_OUTPUT_PER_MTOK_USD` | Token rates per million tokens |
| `OPENAI_PRICE_WEB_SEARCH_CALL_USD` | Rate per web search call |
| `RESERVATION_INPUT_TOKENS` | Input-token allowance per run, including search content |
| `RESERVATION_WEB_SEARCH_CALLS` | Search allowance per run; must be **greater than** `TOOL_CALL_LIMIT` |

**No prices are shipped.** No real prices are set or recommended by the code. The operator copies current rates from the [OpenAI pricing page](https://developers.openai.com/api/docs/pricing), records the date, and sets a new `PRICING_VERSION` whenever any rate changes. Tests use synthetic prices (`test/support/live-env.ts`).

**Policy `reservation-policy-2026-10-19.1`.** Integer micro-USD; every division rounds up.

```
reservation = RESERVATION_INPUT_TOKENS × input rate (uncached)
            + OUTPUT_TOKEN_LIMIT × output rate          (max_output_tokens includes reasoning)
            + RESERVATION_WEB_SEARCH_CALLS × search rate
```

**Why it is conservative:**
- all input is priced at the uncached rate;
- output uses the request's enforced `max_output_tokens`;
- searches use an allowance above `max_tool_calls`, which is not trusted as a cap.

**What remains unbounded:**
- input beyond the allowance (no API limit);
- searches beyond the allowance;
- billing of `open_page`/`find_in_page` actions (not documented by OpenAI);
- any charge the usage report does not show.

The reservation inputs are stored immutably:
- **Reservation row:** `budget_reservation.policy` holds rates, allowances and components; `pricing_version` and `policy_version` identify it.
- **Run snapshot:** `request_snapshot.accounting`.

An old run is never repriced with today's configuration.

## Ledger transitions

`budget_reservation.status` changes only conditionally, under the reservation's row lock. Every change appends `usage_ledger` entries:
- the table is append-only (trigger);
- `operation_key` is unique;
- `amount_micros` is the change of exposure, and the entries of a reservation sum to its exposure.

Replays (recovery, repeated cancellation, repeated settlement) find the status already final and write nothing.

| From → to | When | Exposure |
|---|---|---|
| — → RESERVED (`RESERVE`) | Admission | The reservation |
| RESERVED → RELEASED (`RELEASE`) | No request can exist: cancelled before submission (pause, delete, suspension, eligibility recheck), provider change before submission, or provider refused the request at submit (HTTP 4xx, "not accepted") | 0 |
| RESERVED → SETTLED (`SETTLE`, `OVERRUN`) | Terminal provider response (succeeded, failed, incomplete, cancelled, bounds not confirmed) with complete usage and a priced model | Estimate + uncertain search allowance |
| RESERVED → UNRESOLVED (`UNRESOLVED`, `OVERRUN`) | Ambiguous outcome (UNCERTAIN: unknown submit, interrupted submission, response not retrievable, unconfirmed cancellation); or terminal with missing or partial usage, or an unmapped returned model | max(reservation, partial estimate) |
| SETTLED / UNRESOLVED → RESOLVED (`RESOLVE`) | Operator command with a confirmed amount | The confirmed amount |

**Settlement estimate**, using the run's own policy:
- **Tokens:** (input − cached) × input rate + cached × cached rate + output × output rate. Unreported cached tokens are priced at the full input rate. Missing usage is **unknown, never zero**.
- **Searches:** observed `web_search_call` items × search rate. The count is the larger of the recorded tool items and the stored item count.
- **Uncertain hold:** the part of the search allowance the observed items do not cover. It stays in exposure as "unresolved", because billable searches are not verified. Only an operator resolution removes it.
- **Overruns:** an estimate above the reservation is recorded in full, with an `OVERRUN` entry, never clamped. The higher exposure then reduces the remaining budget, and later admissions are refused when it is exhausted.

**Fencing.** Settlement and release happen in the same fenced transaction that finishes the run. A stale worker fails the fenced update first, so it can neither settle nor release. A worker cannot finalize a completed run again.

**Retries.** Automatic provider retries remain disabled. A future additional submission must get its own reservation through admission. Polling, recovery and `/result` never reserve.

## Unknown cost, reconciliation and operator resolution

Provider-terminal reconciliation and financial resolution are separate:
- **Research reconciliation** (`npm run ops:reconcile`, TRB-020) only records that an UNCERTAIN run was checked at the provider, and unblocks live work. `OPERATOR_ACCEPTED_RISK` does not mean zero spend: the reservation stays UNRESOLVED and fully exposed.
- **Financial resolution** is a separate command:
  ```
  npm run ops:accounting -- --list
  npm run ops:accounting -- --run <id> --confirmed-usd <amount> --operator <name> --note "<billing evidence>"
  ```
  - `--list` shows UNRESOLVED reservations and SETTLED ones with an uncertain hold.
  - Resolution requires a finished run and an explicit amount (`0` must be typed), and is allowed **once**.
  - It sets RESOLVED with exposure equal to the confirmed amount and appends a `RESOLVE` entry with the operator, note and previous exposure.
  - It never contacts OpenAI or Telegram, and never changes the run.
  - Corrections after resolution are not supported yet (TRB-090).

**Procedure:**
1. Find the run's response ID and submission time (`--list`).
2. Read the project's usage or billing for it in the OpenAI dashboard. Dashboard ingestion is delayed and per-request attribution may be ambiguous; record what was actually seen.
3. Run the command with that amount and a note.

## Execution: outbox and the current worker

Admission writes a `RESEARCH_EXECUTE` outbox event. Until TRB-060 connects pg-boss, the existing in-process DB-backed worker is the **only** execution path:
- **Claim.** Its claim statement selects QUEUED runs that have a pending event and marks the event `dispatched_at` in the same statement (data-modifying CTE). No separate dispatcher exists, so nothing can submit twice.
- **Cancellation.** Cancelling a queued run marks its event `cancelled_at`.
- **Requeue.** The fail-closed "return to queue" path makes the event pending again.
- **Unchanged:** restart recovery, leases and fencing, persisted response IDs and no automatic resubmission of unknown submissions.
- **Before a live submission** the worker also requires the run's reservation to be RESERVED (`ACCOUNTING_MISSING` otherwise, with no provider call).

**TRB-060 boundary.** A dispatcher will publish pending events to pg-boss with the run ID as job key and mark them dispatched. The worker will consume jobs, deduplicating in the database (claim is conditional on QUEUED), instead of scanning. The event's `dispatched_at` semantics change from "claimed by the worker" to "published".

## Lifecycle

| Action | Queued runs | Running runs | Deliveries |
|---|---|---|---|
| Task pause | CANCELLED `TASK_PAUSED`; reservation released; event cancelled | May finish and deliver (SPEC §4) | Unchanged |
| Task delete | CANCELLED `TASK_DELETED`; released; event cancelled | Continue (no provider cancellation); results stored, delivery suppressed (`TASK_DELETED`) | Unfinished deliveries of the task's runs suppressed |
| User suspension (TRB-030) | CANCELLED `USER_SUSPENDED`; released; event cancelled | Provider cancellation requested; accounting per outcome | Durable suppression (unchanged) |
| Task edit | Not affected: runs keep their snapshot | — | — |

## `/usage`

The sender's own figures only. It shows:
- **Periods:** the UTC day and month.
- **Quotas:** runs today out of both daily limits, and active runs out of the limit.
- **Live amounts for the month:**
  - "оцінено" (estimates from usage reports);
  - "зарезервовано" (running or queued);
  - "невизначено" (uncertain search hold and unknown costs);
  - "підтверджено оператором";
  - the total against the budget and the remainder for new reservations.

It states that these are application estimates, not an OpenAI invoice, and that a reservation is not provider credit. In simulated mode it says there is no real spend.

## Historical records (migration `20261019194156_trb_050_admission_accounting`)

- **No invented accounting.** Existing runs get no reservation, ledger entry or outbox event, so they are neither settled at zero nor counted against budgets.
  - `admitted_day` and `admitted_month` are backfilled from `created_at` (UTC); `trigger` is MANUAL, which every earlier run was.
  - Existing suppression decisions get reason `USER_SUSPENDED`.
- **Legacy queued runs.** A QUEUED run without a pending execution event (from before TRB-050) is never executed: the worker cancels it before any submission with `ADMISSION_EVIDENCE_MISSING`, with no reply.
- **The owner's development database** has no QUEUED or RUNNING runs and no suppressed runs: 3 finished TRB-020 runs. No cleanup is needed there.
- **Applied migrations** were not rewritten. This migration's statement order was corrected before release, while it existed only in the local development database; that database's recorded checksum was updated to match (docs/VALIDATION.md).

## Defaults and decisions for the owner

These are proposals; none was approved as final.

| Setting | Default | Note |
|---|---|---|
| `USER_ACTIVE_RUN_LIMIT` | 1 | SPEC: one concurrent research per user |
| `USER_DAILY_RUN_LIMIT` | 10 | SPEC proposal |
| `USER_DAILY_MANUAL_RUN_LIMIT` | 5 | SPEC proposal |
| `RESEARCH_QUEUE_LIMIT` | 3 | TRB-020 |
| Budgets, rates, allowances | unset | Must be supplied; live research refused until then |

**Still the owner's decision:**
- **Opening live research to members.** It stays administrator-only; enabling it needs explicit acceptance after reviewing this policy.
- **Allowance values.** The input-token allowance and search allowance (suggestion: at least 2 × `TOOL_CALL_LIMIT`).
- **Search-hold policy.** Whether the uncertain search hold may be released automatically after billing ingestion. Today only operator resolution releases it.

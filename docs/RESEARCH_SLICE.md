# TRB-020 research slice: behaviour, recovery and live sample

Status: DONE (accepted by the owner on 2026-10-19). Authorized live sample performed 2026-10-19: provider integration, delivery and `/result` passed. Tool-call metering is unresolved, and acceptance does not verify `max_tool_calls` as a cap on billable searches (docs/VALIDATION.md, "TRB-020 acceptance"). Apart from that recorded live sample, everything below describes the code as implemented.

TRB-030 (READY FOR REVIEW) replaced the administrator-only access rule with invitations, onboarding and suspension; see docs/IDENTITY.md. The sections below note where it changed this slice.

## Behaviour

Commands are accepted only in the sender's own private chat with the bot (chat ID equal to sender ID, non-bot sender). Group, supergroup and channel updates are recorded as ignored and get no reply.

Since TRB-030 (docs/IDENTITY.md):
- **Who may run research.** Active users with completed onboarding: configured administrators and invited members. Live research is administrator-only until TRB-050.
- **Senders without an account** get the invitation-required reply.
- **Time zone.** Runs use the user's confirmed time zone instead of `RESEARCH_TIME_ZONE`.

| Command | Effect |
|---|---|
| `/research <prompt>` | Validates the prompt (non-empty, at most `RESEARCH_PROMPT_MAX_CHARS` code points) and queues a run. Replies with the run ID. The report is delivered later as separate messages. |
| `/result <run-id>` | Resends the stored report of the sender's own run (a new `RESEND` delivery copying the stored parts). Never starts research. A foreign or missing run gets "not found". Since TRB-030 the lookup is scoped by the owner's user ID. |
| `/start`, `/help` | Help text. |

Ingress (`POST /telegram/webhook`, or development polling) verifies `X-Telegram-Bot-Api-Secret-Token` in constant time. Then, in one transaction, it:
1. inserts `telegram_update(update_id)`; a replay conflicts and becomes a no-op;
2. since TRB-030, takes a per-sender lock and loads the sender's user record;
3. applies authorization;
4. takes an advisory lock and checks the queue bound (`RESEARCH_QUEUE_LIMIT`, QUEUED + RUNNING);
5. inserts the run with its configuration snapshot and owner, plus the acknowledgment delivery.

The HTTP 200 is returned only after commit; research and sending happen in background workers.

The destination is always the authorized private chat of the request, stored on the run. Neither the prompt nor model output can change it.

## Research execution

`ResearchWorker` (since TRB-060 a pg-boss job handler; queue, claim order, attempts and retries are in [QUEUE.md](QUEUE.md)):

1. Claims an eligible QUEUED run (since TRB-060: the least recently served user first) with `UPDATE … FOR UPDATE SKIP LOCKED`, setting `RUNNING`, a 60 s lease and an incremented `fencing_token`. A partial unique index (`research_run_single_running`) guarantees at most one RUNNING run globally, even with several processes. Live runs are not eligible while an unreconciled live run is UNCERTAIN (see [Fail-closed uncertainty](#fail-closed-uncertainty-and-operator-reconciliation)).
2. Builds the request: versioned policy (`research-policy-2026-10-18.1`), the prompt between markers, and an explicit context (UTC time, local time and offset in `RESEARCH_TIME_ZONE`, Monday–Sunday week, queue delay). Stores the exact request in `request_snapshot` and sets `submission_state = SUBMITTING` before calling the provider.
3. OpenAI adapter (`openai@7.27.0`, Responses API): `tools: [{type: "web_search"}]`, `tool_choice: "required"`, `max_output_tokens`, `max_tool_calls`, `background: true`, `store: false`, `include: ["web_search_call.action.sources"]`, optional `reasoning.effort`. No `previous_response_id` or conversation. SDK retries are disabled (`maxRetries: 0`); each HTTP call has `OPENAI_HTTP_TIMEOUT_MS`. No Structured Outputs and no second model call.
4. Saves the response ID (`SUBMITTED`) immediately, before any verification.
5. Bounds verification applies to **every** provider snapshot: the submit response, each poll (including the first poll after a recovery) and any cancellation result. The echoed `max_output_tokens`, `max_tool_calls`, `tool_choice` and web search tool must equal the run's immutable `request_snapshot.request`; current configuration is irrelevant. No "verified" flag is persisted, so a saved response ID never implies verified bounds, and a crash between saving the ID and verification only means the next snapshot is verified. Missing or mismatched bounds never produce a report:
   - terminal response: `FAILED / BOUNDS_NOT_CONFIRMED:…` (output discarded);
   - non-terminal response: cancel; a terminal cancellation result gives `FAILED / BOUNDS_NOT_CONFIRMED:…`, anything else `UNCERTAIN / BOUNDS_NOT_CONFIRMED:…;CANCEL_UNCONFIRMED`.

   A run without a stored request fails with `BOUNDS_NOT_CONFIRMED:request_snapshot`. `max_tool_calls` is documented for `POST /v1/responses` but missing from this SDK version's REST types, so it is added explicitly and only trusted when echoed.
6. Polls every `OPENAI_POLL_INTERVAL_MS`, renewing the lease and recording the newest provider status and usage. At `RUN_DEADLINE_SECONDS` after submission it cancels the response. Only a terminal status returned by the provider counts as confirmed termination:
   - cancellation returns `completed` with confirmed bounds: normal completion;
   - cancellation returns `completed` with unconfirmed bounds: `FAILED / BOUNDS_NOT_CONFIRMED:…`;
   - cancellation returns another terminal status: `FAILED / DEADLINE_EXCEEDED`;
   - cancellation throws, or returns `queued`/`in_progress`: `UNCERTAIN / DEADLINE_CANCEL_UNCONFIRMED` (the request may still run and bill).

   Accounting merges snapshots: the newest status is kept, and missing usage never overwrites known usage.
7. On `completed`: extracts text and `url_citation` annotations, then classifies the outcome deterministically. The model must start with `OUTCOME: FOUND|PARTIAL|NO_MATCHES|INCONCLUSIVE`. That declaration is accepted only when a web search call is present and at least one valid citation exists. Otherwise the outcome is INCONCLUSIVE with a visible warning. Incomplete, failed and cancelled responses are FAILED and never delivered as reports.
8. In one fenced transaction: stores the report, citations, consulted sources, usage, tool-call count and model, sets SUCCEEDED, and creates the REPORT delivery with its rendered parts.

Run states: QUEUED → RUNNING → SUCCEEDED | FAILED | UNCERTAIN | CANCELLED. CANCELLED was added by TRB-030: suspension, an owner who is unresolved or lost access, or live research by a non-administrator. Before submission no provider request exists; after a confirmed provider cancellation the evidence is kept. The content outcome (FOUND, PARTIAL, NO_MATCHES, INCONCLUSIVE) is separate, and so is the delivery state.

## Recovery policy

TRB-060 keeps these rules and adds queue redelivery, attempts and wake-ups ([QUEUE.md](QUEUE.md#recovery-policy)).

| Situation | Behaviour |
|---|---|
| Restart with QUEUED runs | Executed normally; rows are durable. |
| RUNNING, lease expired, `NOT_SUBMITTED` | Taken over (new fencing token) and executed; nothing was sent. |
| RUNNING, lease expired, `SUBMITTING` (request may have reached OpenAI, no response ID saved) | `UNCERTAIN / SUBMISSION_INTERRUPTED`. Never resubmitted automatically; user notified. |
| RUNNING, lease expired, `SUBMITTED` | Polling resumes with the saved response ID; never resubmitted. If the response can no longer be retrieved (HTTP 404, e.g. after the ~10 min background retention of `store: false`), the run becomes `UNCERTAIN / RESPONSE_NOT_RETRIEVABLE`. |
| Submit returns 4xx | `FAILED` (not accepted). Since TRB-060 a 429 rate-limit refusal may get a new attempt with its own reservation when `RESEARCH_SUBMISSION_RETRY_LIMIT` > 0 (default 0). |
| Submit times out, connection error or 5xx | `UNCERTAIN` (may be billed); not retried. |
| Graceful shutdown while polling | Lease released and a wake-up written in one transaction; the next process resumes polling. |
| A worker whose lease was taken over | All its writes are fenced by `(id, fencing_token, state = RUNNING)`; they fail and it stops. A response ID it receives too late is logged for reconciliation. |
| RUNNING, lease expired, `SUBMITTED`, bounds not yet verified | The first poll result is verified like a fresh submission (see step 5). |
| Deadline or bounds-failure cancellation fails or is not confirmed | `UNCERTAIN`; the response ID, newest status and usage are kept. |
| Run admitted under one provider (fake/live), executed under another | Before submission: `FAILED / PROVIDER_CHANGED`. After submission: `UNCERTAIN / PROVIDER_CHANGED_AFTER_SUBMISSION`. Never a silent fallback. |

No UNCERTAIN run is ever resubmitted. A deliberate new `/research` creates a new run.

## Fail-closed uncertainty and operator reconciliation

An UNCERTAIN live run (`provider_kind = 'openai'`) may correspond to a provider request that is still running and billing. Until an operator reconciles it:
- **New live requests are refused.** `/research` replies that live research is blocked, and no run is created. This admission check is best-effort UX.
- **Queued live runs stay QUEUED.** They are not lost or failed, but no worker claims them. The authoritative check is part of the single claim statement, together with the single-RUNNING check. A run is RUNNING until the commit that makes it UNCERTAIN, so no interleaving of workers and admission lets a live run start. A pre-submission re-check returns a run to the queue as defence in depth.
- **Fake (simulated) uncertainty never blocks.** Its notice is labelled СИМУЛЯЦІЯ and states that no real request or cost occurred.

UNCERTAIN codes: `SUBMISSION_INTERRUPTED`, an unknown submit outcome (`OPENAI_CONNECTION`, `OPENAI_HTTP_5xx`, …), `RESPONSE_NOT_RETRIEVABLE`, `DEADLINE_CANCEL_UNCONFIRMED`, `BOUNDS_NOT_CONFIRMED:…;CANCEL_UNCONFIRMED`, `PROVIDER_CHANGED_AFTER_SUBMISSION`, `SUSPENDED_CANCEL_UNCONFIRMED` (TRB-030: the owner was suspended while the request ran, and cancellation was not confirmed).

Reconciliation procedure (operator only; never contacts OpenAI or Telegram, never resubmits):
1. List unresolved runs: `npm run ops:reconcile -- --list`. In Docker: `node dist/ops/reconcile-run.js --list`. The command uses `DATABASE_URL`.
2. For each run, check in the OpenAI dashboard (Logs/Usage for the project, around `submittedAt`, by `providerResponseId` when present) whether a response exists, whether it is still running and what it cost. Cancel it there if it is still running.
3. Record the decision:
   `npm run ops:reconcile -- --run <id> --resolution <PROVIDER_CONFIRMED_TERMINAL|PROVIDER_REQUEST_ABSENT|OPERATOR_ACCEPTED_RISK> --operator <name> --note "<what was checked and the observed cost>"`
4. The command locks the run and requires `state = UNCERTAIN` with no previous reconciliation. It then appends a `research_reconciliation` row and sets `research_run.reconciled_at`. The row is append-only (a trigger rejects UPDATE/DELETE) and holds the operator, resolution, note and an evidence snapshot: failure code, submission state, response ID, provider status, usage and timestamps.
5. The run stays UNCERTAIN with its failure code, response ID and usage. Workers cannot reconcile, and a stale worker cannot change the run afterwards, because its fenced writes require `RUNNING`. Queued live work proceeds on the next worker tick.

## Tool telemetry (diagnostic)

Every provider snapshot's `web_search_call` items are recorded in `research_tool_item`:
- **One row per item.** Rows are keyed by response ID and item ID. Repeated observations update the latest status and `action.type` instead of adding rows; missing values never overwrite reported ones, and omitted items are kept.
- **Writes are fenced.** A stale worker records nothing.
- **Content-free.** No queries, URLs or page content are stored.
- **Marker.** `research_run.tool_telemetry_version` is `1` for runs with telemetry. It is `NULL` for older runs, which report `not_recorded` rather than zero.

Terms:
- **observed tool items:** distinct items;
- **observed items by status/action:** their latest reported values;
- **`tool_call_count`:** web_search_call output items in the final snapshot (historical meaning);
- **billable search count:** unknown. Provider output does not state what is billed; only billing evidence can.

Inspect with `npm run ops:tool-telemetry -- --run <id>` (read-only).

## Delivery

> **Updated by TRB-080 ([DELIVERY.md](DELIVERY.md)).** The description below is the TRB-020 behaviour. Since TRB-080:
> - deliveries go through a separate pg-boss queue (`delivery-send`), in creation order per chat;
> - a 5xx answer is retried, and a connection that was never opened is retried instead of becoming `UNKNOWN`;
> - a confirmed blocked chat pauses automatic research;
> - a report longer than 6 messages is sent as a summary plus a complete UTF-8 text document instead of being truncated;
> - "non-clickable" below means not rendered as a link: Telegram clients may still auto-detect a bare URL in text.

`DeliveryWorker` sends deliveries oldest-first, one part at a time. Before each request the part is marked SENDING; right after success it is marked SENT with the Telegram message ID, so confirmed parts are never resent.

- Telegram error response (definite, nothing created): 429 waits `retry_after`; other retryable errors back off, up to 5 attempts. 400, 403 and 404 are `PERMANENT_FAILURE`.
- Network error or timeout (outcome unknown): the part and the delivery become `UNKNOWN`. There is no automatic resend, because Telegram `sendMessage` has no idempotency key. The user can request `/result <id>`, which is an explicit resend and may duplicate.
- A worker that dies while SENDING: on lease expiry, the in-flight part becomes `UNKNOWN`.
- Delivery never calls the research provider. A delivery failure never changes the run state.

Rendering (`report-renderer.ts`) is deterministic Telegram HTML:
- **Escaping.** All provider text is escaped.
- **Citations.** Only provider `url_citation` annotations become links, placed directly after the annotated claim. The model's own markdown citation span is replaced by a numbered `[n]` link. A numbered source list follows the report.
- **URL validation.** URLs must be absolute http(s) without credentials, at most 2048 characters.
- **Unannotated links.** URLs the model wrote without an annotation stay non-clickable text.
- **Splitting.** Parts are at most 3900 UTF-16 units of HTML, which is below Telegram's 4096 limit. Splits fall on paragraph, line, sentence, word, then grapheme boundaries. Links are indivisible. There are at most 6 parts, and the last carries a visible truncation note; the full text stays in `research_run.report_text`.
- **Simulated runs.** Fake-provider results carry a "СИМУЛЯЦІЯ" banner.

## Cost controls: what is and is not enforced

Enforced by TRB-020:
- explicit `RESEARCH_MODE=live` opt-in;
- operator-selected model;
- `max_output_tokens`, which includes reasoning tokens;
- `max_tool_calls`;
- a run deadline with cancel;
- one run globally and a bounded queue;
- no SDK or application retry of a potentially billed request.

Not enforced:
- **Dollar amounts.** Enforced since TRB-050 as application accounting: reservations, monthly budgets and a per-run maximum (docs/ACCOUNTING.md). This is not a provider spending ceiling.
- **Input tokens.** These include retrieved search content and are not bounded by these settings. OpenAI's documentation limits the web search context window to 128k tokens.
- **Billing on failure.** A cancelled or failed request may still be billed.

### OpenAI spending controls (checked 2026-10-19 against the [Spend limits](https://developers.openai.com/api/docs/guides/spend-limits) guide)

Three different things; only the second stops traffic:

| Control | Effect |
|---|---|
| Spend alert (notification threshold) | Sends a notification; API traffic continues. Not a cap. |
| Hard spend limit: a monthly spend limit with **"Enforce a hard limit"** turned on, per organization or per project | At the limit, requests fail with HTTP 429 (`project_spend_limit_exceeded` or `organization_spend_limit_exceeded`). Enforcement is not instantaneous, so recorded spend can slightly exceed the configured amount; it is not an exact dollar ceiling. Resets with the monthly cycle or when the limit is raised or removed. The guide does not say whether in-flight requests are stopped. |
| Application budgets (`USER_MONTHLY_BUDGET_USD`, `GLOBAL_MONTHLY_BUDGET_USD`, `RUN_MAX_ESTIMATED_COST_USD`) | Since TRB-050: admission is refused when the application's accounting (reservations, estimates, unresolved amounts) would exceed them; live admission is refused while any is missing. They do not stop a request that is already running and are not an exact invoice ceiling (docs/ACCOUNTING.md). |

Entering a budget amount without turning on "Enforce a hard limit" leaves only notifications. A project hard limit with enforcement enabled remains the only mechanism that stops billed traffic at the provider; TRB-050 budgets only refuse new admissions. Older community reports describe project limits as notification-only. Verify the toggle in your own dashboard rather than assuming the account has it. A request rejected with 429 `*_spend_limit_exceeded` at submit is classified as not accepted, giving FAILED.

## Deferred

| To | Items |
|---|---|
| TRB-030 | Implemented (READY FOR REVIEW, docs/IDENTITY.md): invitations, user records, onboarding, per-user serialization. The inbox still stores no payload. |
| TRB-050 | Budget reservations, pricing snapshots, usage ledger, quotas, retries with fresh reservation |
| TRB-060 | Done in TRB-060 (READY FOR REVIEW): pg-boss with outbox, attempts table, bounded retry policy, fair dispatch. Process roles remain for TRB-100 |
| TRB-080 | Full-text document fallback, history, blocked-destination handling that pauses automatic work |
| TRB-090 | Retention cleanup: implemented, off by default (docs/RETENTION.md) |
| TRB-100 | Webhook registration runbook, migration release step (the runtime image has no Prisma CLI), deployment |

## Authorized live sample procedure (performed 2026-10-19)

Requires explicit owner authorization: it makes a billed OpenAI request and sends real Telegram messages.

Prerequisites:
1. **Telegram bot.** A bot token from @BotFather (a dedicated test bot is recommended) and your numeric Telegram user ID.
2. **OpenAI project and hard spend limit.** Use a dedicated project and an API key for that project only.
   - In the dashboard, open Project settings → Limits → Spend → "Edit spend limit". Enter a small monthly spend limit and **turn on "Enforce a hard limit"**, then Save.
   - Confirm afterwards that the toggle shows as enforced. If your account does not offer it, stop: do not run the live sample with notification-only alerts.
   - Optionally add a spend alert below the limit for early notice.
   - Remember that enforcement lags, so spend can slightly exceed the limit.
   - Note whether the project uses Zero Data Retention (background mode then runs with `store=false`, as this adapter requests anyway).
3. **Model.** Select a model that the [web search guide](https://developers.openai.com/api/docs/guides/tools-web-search) lists as supporting `web_search` in the Responses API. Do not use `minimal` reasoning. Record the model name and the [pricing](https://developers.openai.com/api/docs/pricing) page date.
4. **Bounds.** Suggested values, for owner approval: `OUTPUT_TOKEN_LIMIT=4000`, `TOOL_CALL_LIMIT=3`, `RUN_DEADLINE_SECONDS=300`, `RESEARCH_QUEUE_LIMIT=1`. Estimate the worst case from the pricing page: output at most 4000 tokens, at most 3 tool calls, and input that includes search context of up to 128k tokens.
5. **No webhook.** Make sure no webhook is registered for the token: `getWebhookInfo` must return an empty `url`. Polling never deletes a webhook; if one exists it stops with a 409.

Steps (local, polling, no public URL needed):
1. Run `npm run db:up`, `npm run db:migrate:deploy` and `npm run build`.
2. In `.env`, set:
   ```
   TELEGRAM_MODE=polling
   TELEGRAM_BOT_TOKEN=…
   ADMIN_TELEGRAM_IDS=<your id>
   RESEARCH_MODE=live
   OPENAI_API_KEY=…
   OPENAI_MODEL=<selected>
   OUTPUT_TOKEN_LIMIT=4000
   TOOL_CALL_LIMIT=3
   RUN_DEADLINE_SECONDS=300
   RESEARCH_QUEUE_LIMIT=1
   ```
3. Run `npm start`. Confirm the startup warning `LIVE research enabled` and the logged model and bounds.
4. In a private chat with the bot, send `/start` and confirm the time zone (required since TRB-030), then send one prompt:
   `/research Які офіційні матчі чоловічої основної команди FC Barcelona заплановані на наступний календарний тиждень (понеділок–неділя, Europe/Kyiv)? Для кожного: суперник, турнір, дата і час початку за Києвом. Посилайся на офіційні джерела; якщо час не визначено, так і напиши.`
5. Inspect the Telegram messages:
   - acknowledgment with the run ID;
   - report without the СИМУЛЯЦІЯ banner;
   - `[n]` links next to each claim, each opening a page that supports that claim;
   - outcome and warnings; checked-at time in Kyiv and UTC.
6. Inspect the database:
   ```sql
   SELECT state, outcome, failure_code, provider_response_id, provider_model, tool_call_count, usage,
          jsonb_array_length(citations) AS citations, jsonb_array_length(sources) AS sources,
          request_snapshot->'request'->>'maxOutputTokens' AS max_output, request_snapshot->'request'->>'maxToolCalls' AS max_tools,
          submitted_at, completed_at
     FROM research_run ORDER BY created_at DESC LIMIT 1;
   SELECT kind, state, last_error_code, attempts, (SELECT count(*) FROM delivery_part p WHERE p.delivery_id = d.id) AS parts
     FROM delivery d ORDER BY created_at;
   ```
   Compare `usage` and the response ID with the OpenAI dashboard.
7. Send `/result <run-id>`. The stored report must arrive again with no new OpenAI request in the dashboard.
8. Record in docs/VALIDATION.md:
   - date, model, bounds and elapsed time;
   - usage and estimated cost (manual, from the pricing snapshot);
   - source quality notes and limitations.
9. Disable live execution:
   - stop the process;
   - set `RESEARCH_MODE=disabled` (or `fake`) and `TELEGRAM_MODE=disabled`;
   - remove the key and token from `.env`, rotating them if they were exposed;
   - if any run ended UNCERTAIN, reconcile it (procedure above) before the next live session; lower or keep the project hard limit as appropriate.

For a webhook environment, registration is `setWebhook` with `url=$PUBLIC_BASE_URL/telegram/webhook`, `secret_token=$TELEGRAM_WEBHOOK_SECRET` and `allowed_updates=["message","callback_query"]`; the callback updates are needed for the onboarding buttons since TRB-030. This runbook item belongs to TRB-100.

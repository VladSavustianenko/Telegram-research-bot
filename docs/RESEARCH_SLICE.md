# TRB-020 research slice: behaviour, recovery and live sample

Status: implementation READY FOR REVIEW; authorized live sample PENDING. Everything below describes the code as implemented; nothing here has been observed against the real OpenAI or Telegram APIs.

## Behaviour

Administrator-only prototype. Commands are accepted only from a sender listed in `ADMIN_TELEGRAM_IDS`, in that sender's private chat with the bot (chat ID equal to sender ID, non-bot sender). Group, supergroup and channel updates are recorded as ignored and get no reply. Other private users get a generic "private bot" reply.

| Command | Effect |
|---|---|
| `/research <prompt>` | Validates the prompt (non-empty, at most `RESEARCH_PROMPT_MAX_CHARS` code points) and queues a run. Replies with the run ID. The report is delivered later as separate messages. |
| `/result <run-id>` | Resends the stored report of the sender's own run (a new `RESEND` delivery copying the stored parts). Never starts research. A foreign or missing run gets "not found". |
| `/start`, `/help` | Help text. |

Ingress (`POST /telegram/webhook`, or development polling) verifies `X-Telegram-Bot-Api-Secret-Token` in constant time, then in one transaction: inserts `telegram_update(update_id)` (a replay hits the primary key and becomes a no-op), applies authorization, takes an advisory lock, checks the queue bound (`RESEARCH_QUEUE_LIMIT`, QUEUED + RUNNING), and inserts the run with its configuration snapshot plus the acknowledgment delivery. The HTTP 200 is returned only after commit; research and sending happen in background workers.

The destination is always the authorized private chat of the request, stored on the run. Neither the prompt nor model output can change it.

## Research execution

`ResearchWorker` (in-process loop, database-backed):

1. Claims the oldest QUEUED run with `UPDATE … FOR UPDATE SKIP LOCKED`, setting `RUNNING`, a 60 s lease and an incremented `fencing_token`. A partial unique index (`research_run_single_running`) guarantees at most one RUNNING run globally, even with several processes.
2. Builds the request: versioned policy (`research-policy-2026-10-18.1`), the prompt between markers, and an explicit context (UTC time, local time and offset in `RESEARCH_TIME_ZONE`, Monday–Sunday week, queue delay). Stores the exact request in `request_snapshot` and sets `submission_state = SUBMITTING` before calling the provider.
3. OpenAI adapter (`openai@7.27.0`, Responses API): `tools: [{type: "web_search"}]`, `tool_choice: "required"`, `max_output_tokens`, `max_tool_calls`, `background: true`, `store: false`, `include: ["web_search_call.action.sources"]`, optional `reasoning.effort`. No `previous_response_id` or conversation. SDK retries are disabled (`maxRetries: 0`); each HTTP call has `OPENAI_HTTP_TIMEOUT_MS`. No Structured Outputs and no second model call.
4. Saves the response ID (`SUBMITTED`), then verifies the echoed `max_output_tokens`, `max_tool_calls`, `tool_choice` and web search tool. If any is not confirmed, the response is cancelled and the run fails with `BOUNDS_NOT_CONFIRMED:…`. `max_tool_calls` is documented for `POST /v1/responses` but missing from this SDK version's REST types, so it is added explicitly and only trusted when echoed.
5. Polls every `OPENAI_POLL_INTERVAL_MS`, renewing the lease. At `RUN_DEADLINE_SECONDS` after submission it cancels the response and fails with `DEADLINE_EXCEEDED`.
6. On `completed`: extracts text and `url_citation` annotations, then classifies the outcome deterministically. The model must start with `OUTCOME: FOUND|PARTIAL|NO_MATCHES|INCONCLUSIVE`. That declaration is accepted only when a web search call is present and at least one valid citation exists. Otherwise the outcome is INCONCLUSIVE with a visible warning. Incomplete, failed and cancelled responses are FAILED and never delivered as reports.
7. In one fenced transaction: stores the report, citations, consulted sources, usage, tool-call count and model, sets SUCCEEDED, and creates the REPORT delivery with its rendered parts.

Run states: QUEUED → RUNNING → SUCCEEDED | FAILED | UNCERTAIN. The content outcome (FOUND, PARTIAL, NO_MATCHES, INCONCLUSIVE) is separate, and so is the delivery state.

## Recovery policy (prototype)

| Situation | Behaviour |
|---|---|
| Restart with QUEUED runs | Executed normally; rows are durable. |
| RUNNING, lease expired, `NOT_SUBMITTED` | Taken over (new fencing token) and executed; nothing was sent. |
| RUNNING, lease expired, `SUBMITTING` (request may have reached OpenAI, no response ID saved) | `UNCERTAIN / SUBMISSION_INTERRUPTED`. Never resubmitted automatically; user notified. |
| RUNNING, lease expired, `SUBMITTED` | Polling resumes with the saved response ID; never resubmitted. If the response can no longer be retrieved (HTTP 404, e.g. after the ~10 min background retention of `store: false`), the run becomes `UNCERTAIN / RESPONSE_NOT_RETRIEVABLE`. |
| Submit returns 4xx | `FAILED` (not accepted, not retried). |
| Submit times out, connection error or 5xx | `UNCERTAIN` (may be billed); not retried. |
| Graceful shutdown while polling | Lease released immediately; the next process resumes polling. |
| A worker whose lease was taken over | All its writes are fenced by `(id, fencing_token, state = RUNNING)`; they fail and it stops. A response ID it receives too late is logged for reconciliation. |
| Run admitted under one provider (fake/live), executed under another | `FAILED / PROVIDER_CHANGED`; never a silent fallback. |

Operator action for UNCERTAIN runs: look up the run's request time (and any logged `responseId`) in the OpenAI dashboard to determine usage, then record the decision outside the app. A deliberate new `/research` creates a new run. There is no automatic retry in TRB-020.

## Delivery

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
- **Dollar amounts.** `RUN_MAX_ESTIMATED_COST_USD` and the monthly budgets are parsed but not enforced; budget reservation belongs to TRB-050.
- **Input tokens.** These include retrieved search content and are not bounded by these settings. OpenAI's documentation limits the web search context window to 128k tokens.
- **Billing on failure.** A cancelled or failed request may still be billed.

Use an OpenAI project spending limit as the only hard monetary ceiling until TRB-050.

## Deferred

| To | Items |
|---|---|
| TRB-030 | Invitations, user records, onboarding, per-user serialization, sanitized inbox payload retention |
| TRB-050 | Budget reservations, pricing snapshots, usage ledger, quotas, retries with fresh reservation |
| TRB-060 | pg-boss with outbox, attempts table, configurable retry policy, fair dispatch, process roles |
| TRB-080 | Full-text document fallback, history, blocked-destination handling that pauses automatic work |
| TRB-090 | Retention cleanup: prompts and reports are currently stored without automatic purge |
| TRB-100 | Webhook registration runbook, migration release step (the runtime image has no Prisma CLI), deployment |

## Authorized live sample procedure (PENDING)

Requires explicit owner authorization: it makes a billed OpenAI request and sends real Telegram messages.

Prerequisites:
1. **Telegram bot.** A bot token from @BotFather (a dedicated test bot is recommended) and your numeric Telegram user ID.
2. **OpenAI project.** An OpenAI API key for a project with a spending limit configured in the OpenAI dashboard. Note whether the project uses Zero Data Retention (background mode then runs with `store=false`, as this adapter requests anyway).
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
4. In a private chat with the bot, send `/help`, then one prompt:
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
   - remove the key and token from `.env`, rotating them if they were exposed.

For a webhook environment, registration is `setWebhook` with `url=$PUBLIC_BASE_URL/telegram/webhook`, `secret_token=$TELEGRAM_WEBHOOK_SECRET` and `allowed_updates=["message"]`. This runbook item belongs to TRB-100.

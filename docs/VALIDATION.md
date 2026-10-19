# Validation and acceptance evidence

Use deterministic unit tests, real disposable PostgreSQL integration tests for invariants, and bounded live checks only with operator authorization. Record actual commands/results once implemented. This document contains a plan, not claimed test results.

## Critical automated scenarios

| Risk | Required evidence |
|---|---|
| Cross-user access | User B cannot view/edit/run/delete/resend User A's task or history via forged IDs, callbacks or paging |
| Invitation races | Concurrent redemption admits exactly one account; expiry and replay fail |
| Duplicate inbound update | Same update produces one durable business action |
| Admission races | Two clicks and scheduler race cannot create two active runs or overspend reservations |
| Transaction gap | Crash after commit/before queue send recovers through outbox |
| Provider restart | Known response ID is resumed, not resubmitted |
| Unknown provider outcome | No automatic resubmission; funds remain reserved and state is visible |
| Lease takeover | Old worker cannot finalize after a newer fencing token |
| DST | Kyiv and another zone have one occurrence on repeated local time; skipped time follows documented policy |
| Downtime | One eligible catch-up only; stale missed periods do not flood the user |
| Lifecycle races | Pause/edit/delete/suspend during queue/run/delivery matches SPEC |
| Delivery recovery | Known sent chunks remain sent; delivery retries cause zero additional provider calls |
| Ambiguous Telegram send | UNKNOWN is visible and no blind automatic duplicate is emitted |
| Renderer | Escaped HTML, unsafe links, emoji/surrogate boundaries, citation offsets and chunk limits are handled |
| Cost accounting | User/global limits, UTC rollover, settlement replay and unknown cost handling remain correct |
| Persistent drafts | Restart resumes valid draft; expired/stale input cannot mutate a different task |

## Research quality evaluation

Use a small dated sample, with the same prompt/context across candidate models. Do not require any particular factual answer in mock tests. Record model/configuration, prompt version, time, source links, elapsed time, tokens/tool usage, estimated cost and limitations.

1. Football: next calendar week's fixtures for FC Barcelona, Real Madrid, Paris Saint-Germain, Bayern Munich and Manchester City; competition, teams and Europe/Kyiv kickoff. Compare to official fixture pages, including postponements and TBD times. Do not conflate men's/women's/youth teams; default example explicitly requests men's senior teams.
2. Shopping: sports shorts or T-shirts up to UAH 700 from Under Armour, Nike, Adidas or New Balance in Ukrainian online stores; item, observed price, available sizes if visible, source and checked-at time. Physical-store stock is excluded. Avoid presenting an old snippet price as verified current price.
3. Politics: public political news for a specified country and explicit past-week window; distinguish event/publication dates, prioritize primary statements and distinguish reporting from analysis. This is reporting, not a political persuasion system.
4. Markets: earnings/guidance news for named tickers in an explicit time window; source, event date and concise reported change. Avoid unsourced numeric claims or turning news summaries into personalized investment advice.
5. No evidence: intentionally rare criteria. Expected behavior is uncertainty/partial coverage, never invented matches or proof-of-absence claims.
6. Hostile evidence fixture: retrieved text asks to reveal secrets/change destination/ignore budget. The output and application actions must retain the original task boundaries.

Assess: source support, relevance, temporal correctness, completeness against the bounded reference set, uncertainty handling, citation usability and cost/latency. Treat any invented source or false claim of verified availability as a failed sample. Partial coverage must be labelled; no model choice can guarantee exhaustive web coverage.

## Recorded evidence

### TRB-010 evidence (2026-10-18, local Windows 11, Node 24.19.0, npm 11.17.0, Docker 29.7.2)

All observations are local; no OpenAI or Telegram call was made. CI workflow was written but has not run on a hosted runner.

| Check | Command | Result |
|---|---|---|
| Clean install | `npm ci` | Pass; 489 packages, Prisma client generated |
| Format / lint / types | `npm run format:check`, `npm run lint`, `npm run typecheck` | Pass |
| Schema | `npm run prisma:validate` | Pass |
| Unit tests | `npm test` | 21 passed (config validation, secret non-disclosure, micro-USD parsing, health 200/503/timeout with fake DB, test-DB guard) |
| Integration tests | `npm run test:integration` against compose `postgres-test` | 3 passed; real disposable DB `trb_it_*` created, migrated and dropped (0 left over) |
| Missing test server | `npm run test:integration` without `TEST_DATABASE_URL` | Fails with explicit message, no tests run |
| Build | `npm run build` | Pass |
| Local startup | README "Local development" steps | `/health/live` 200; `/health/ready` 200, 503 after stopping dev DB, 200 after restart |
| Invalid config | `node dist/main.js` with missing/invalid variables | Exit 1, lists variable names; secret values not printed |
| Docker image | `docker build` then run with `PORT=8080` | Pass; JSON logs in production; health 200; `docker stop` (SIGTERM) exit 0 in < 1 s; image contains no `.env` |

### TRB-010 review fixes (2026-10-18, reviewed commit 5ec68d1)

Finding 1 (test database guard bypass) and Finding 2 (readiness timeout left database work running). Local Windows 11, Node 24.19.0, Docker 29.7.2; no OpenAI or Telegram calls.

| Check | Command | Result |
|---|---|---|
| Reproduction before fix | ad-hoc script: built app (commit 5ec68d1) against a loopback TCP server that accepts but never answers | 3 sequential probes: each "down" after ~2 s, open server sockets 1 → 2 → 3; `app.close()` not finished after 8 s |
| Same script after fix | as above, new build | open sockets never above 1, released at the 5 s connect timeout; `app.close()` 3 ms |
| Driver semantics | ad-hoc script: plain `pg.Pool` with `connectionTimeoutMillis: 300` against the same server | Query fails after ~300 ms and the server observes the socket closed (pool total 0, open sockets 0) |
| Guard regression tests | `npx vitest run --config vitest.config.mts test/support` | 32 passed: `host`/`port`/`hostaddr` overrides (incl. upper-case and percent-encoded keys) rejected; loopback aliases (127.0.0.1, 127.0.0.2, ::1, 127.1, ::ffff:127.0.0.1, LOCALHOST., percent-encoded) on the same port refused; omitted port normalised to 5432 and PGPORT considered for DATABASE_URL; same override policy for DATABASE_URL; non-local opt-in keeps the app-server exclusion; no credentials in errors; endpoint agrees with `pg-connection-string`; separate dev 5434 / test 5433 accepted. No connections opened |
| Stalled-endpoint regression tests | `npm test` (`src/health/health.stall.spec.ts`) | 10 sequential/concurrent probes open exactly 1 connection; it is closed at the connect timeout (server-side socket count 0, pool total 0); shutdown drains in < 2 s; with a 60 s connect timeout shutdown returns after the 300 ms shutdown timeout |
| Unit tests | `npm test` | 52 passed |
| Real PostgreSQL | `npm run test:integration` | 6 passed: readiness recovers 503 → 200 after the stalled endpoint starts forwarding to PostgreSQL (stalled socket closed, 1 pooled connection left); `SELECT pg_sleep(5)` cancelled by a 300 ms statement timeout and readiness stays 200; shutdown during a running statement returns in < 1 s and the statement is then cancelled server-side. 0 disposable databases left |
| Static checks / build | `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run build` | Pass |
| Docker smoke | `docker build`, run with `PORT=8080` | live 200; ready 200 → 503 with dev DB stopped → 200 after restart; `docker stop` exit 0 in 0.7 s; logs contain error names/codes only |

Limitations: a server that completes the handshake and then stops responding is bounded by the client-side read timeout (statement timeout + 5 s), not by the connect timeout. Different DNS names for the same remote server are not detected by the test guard.

### TRB-020 evidence (2026-10-18, local Windows 11, Node 24.19.0, Docker 29.7.2)

Mock validation only. No OpenAI request was made and no Telegram message was sent; all results come from fake provider and Telegram adapters, or from a container without internet access. Fake fixtures prove application behaviour, not search quality.

| Check | Command | Result |
|---|---|---|
| Clean install | `npm ci` | Pass (498 packages; adds grammy 1.46.0, openai 7.27.0) |
| Static checks | `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run prisma:validate` | Pass |
| Unit tests | `npm test` | 110 passed (9 files) |
| Integration tests | `npm run test:integration` against compose `postgres-test` | 34 passed (4 files, including TRB-010 suites); 0 disposable databases left |
| Build | `npm run build` | Pass |
| Docker smoke (fake mode) | image run with `NODE_ENV=production`, `TELEGRAM_MODE=webhook`, `RESEARCH_MODE=fake`, on an internal Docker network (database only, no internet) | Webhook with valid secret: 200 in 212 ms; same update_id again: 200, deduplicated (1 `telegram_update`, 1 run); wrong secret: 401. Run SUCCEEDED / FOUND / SUBMITTED, 2 tool calls. Both deliveries became UNKNOWN / TELEGRAM_NETWORK after one attempt, with no automatic resend. Token, webhook secret, prompt text and DB credentials absent from logs. `docker stop` exit 0 in 2.6 s |

Scenarios covered by automated tests:
- **Authorization:** non-admin, group chat, bot sender, chat/sender mismatch, admin ID in text from a non-admin.
- **Webhook and ingress:** missing/wrong webhook secret (no rows written); duplicate and concurrent replay of one update creates one run.
- **Acknowledgment:** sent while the provider call is still pending; the run is persisted (QUEUED) before the 200.
- **Disabled research:** no run, no provider call. Live config without key, model or bounds fails validation without echoing secrets; `minimal` reasoning, a deadline over 540 s, and `RESEARCH_CONCURRENCY` ≠ 1 are rejected.
- **Request contents:** `web_search` + `tool_choice: "required"`, `max_output_tokens`, `max_tool_calls`, `background`, `store: false`, no previous response or conversation, SDK `maxRetries: 0`.
- **Unconfirmed bounds:** cancel + FAILED.
- **Queue and concurrency:** queue bound under 6 concurrent requests with limit 2; one RUNNING run across two app instances.
- **Report before delivery:** the report is checked in the DB at send time.
- **Rendering:** escaping of injected HTML; unsafe or credentialed URLs dropped; citation links placed after claims; unannotated model links not clickable; long Cyrillic/emoji/ZWJ/flag reports split within 3900 UTF-16 units with balanced links and well-formed strings; truncation at 6 parts; deterministic output; all three dated fixtures (football, shopping, news) rendered.
- **Classification:** missing citations, missing web search or missing outcome line → INCONCLUSIVE with warning.
- **Failure paths:** incomplete output not delivered; deadline cancels; 4xx → FAILED and unknown → UNCERTAIN, both without retry.
- **Delivery:** retry after 429 resumes from the failed part (part 1 not resent) with zero additional provider calls; ambiguous send → UNKNOWN, no automatic resend; explicit `/result` resends stored parts with no provider call; crash while SENDING → UNKNOWN; permanent 403 keeps the run SUCCEEDED; `/result` is owner-scoped.
- **Recovery:** queued work after restart; NOT_SUBMITTED takeover; SUBMITTING → UNCERTAIN with zero provider calls; SUBMITTED resumes polling the saved ID; non-retrievable response → UNCERTAIN; a stale worker cannot finalize after takeover; provider change → FAILED.
- **Logs:** no token, webhook secret, DB credentials or prompt text.

Live sample: **PENDING**. Requires owner authorization (billed OpenAI request and real Telegram messages); procedure in docs/RESEARCH_SLICE.md. Not yet verified live:
- that the selected model accepts `web_search` with `tool_choice: "required"`, `background: true`, `store: false` and `max_tool_calls`, and echoes `max_tool_calls`;
- the unit of annotation offsets (the code handles code points and UTF-16);
- actual source quality, latency and cost.

### TRB-020 review fixes (2026-10-19, reviewed commit 1d01db6)

Finding 1 (recovery bypassed bounds verification), Finding 2 (failed or unconfirmed cancellation treated as definite failure) and the spending-control documentation. Local Windows 11, Node 24.19.0, Docker 29.7.2. Mock validation only: no OpenAI request, no Telegram message.

| Check | Command | Result |
|---|---|---|
| Migration | `prisma migrate dev --create-only`, then `migrate deploy` / `migrate status` against the dev DB | `20261019091824_trb_020_uncertainty_reconciliation` applied: `reconciled_at`, append-only `research_reconciliation` (trigger), check and partial index. "Database schema is up to date"; `migrate diff --exit-code` reports no drift |
| Static checks | `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run prisma:validate` | Pass |
| Unit tests | `npm test` | 112 passed (10 files) |
| Integration tests | `npm run test:integration` | 56 passed (5 files); 0 disposable databases left |
| Regression tests fail on the reviewed code | new `research-uncertainty.int-spec.ts` "Finding" tests run with `research-worker.service.ts` from 1d01db6 | 12 failed, 3 passed (the 3 cover correct paths: valid recovery, confirmed cancellation usage, completed cancellation with valid bounds) |
| Build | `npm run build` | Pass |
| Reconcile CLI | `npm run ops:reconcile` on a scratch database with one UNCERTAIN live run | `--list` shows it; missing arguments: exit 2; reconcile: exit 0 and audit row; second attempt: `ALREADY_RECONCILED`, exit 1; run stays UNCERTAIN with failure code and response ID; list then empty |
| Docker smoke (fake mode) | image on an internal Docker network, as for TRB-020 | Webhook 200 / duplicate deduplicated / wrong secret 401; real FakeResearchProvider run SUCCEEDED; deliveries UNKNOWN without resend; `node dist/ops/reconcile-run.js --list` works in the image; no token, secret, prompt or DB credentials in logs; `docker stop` exit 0 in 2.6 s |

Regression scenarios (`test/integration/research-uncertainty.int-spec.ts`, `src/research/provider/fake.provider.spec.ts`):
- **Finding 1, recovery.** A crash after saving the response ID and before verification: recovered `queued`/`in_progress` responses with unconfirmed bounds are cancelled and FAILED. Recovered `completed` responses with missing or mismatched bounds are discarded (FAILED, no report, usage kept, no cancel).
- **Finding 1, correct paths.** A valid recovered response completes with zero submissions. Verification uses the run snapshot even when current `OUTPUT_TOKEN_LIMIT`/`TOOL_CALL_LIMIT` differ. A missing request snapshot is unverifiable.
- **Finding 2, cancellation.** Deadline cancellation throwing a network error, or returning `queued`/`in_progress`, gives UNCERTAIN `DEADLINE_CANCEL_UNCONFIRMED` with the response ID, newest status and poll usage kept. Bounds-failure cancellation throwing gives UNCERTAIN. A confirmed cancellation stores its returned usage, and without usage keeps the earlier usage. A completed cancellation response is accepted only with confirmed bounds.
- **Fail-closed blocking.** After an unknown submission outcome, and after an interrupted submission without an ID, a queued live run stays QUEUED across two concurrent workers and a new live `/research` is refused without creating a run. Explicit reconciliation lets the queued run execute: one new submission, for the queued run only, and the original stays UNCERTAIN with its evidence.
- **Fake mode.** Simulated uncertainty does not block, and its notice says СИМУЛЯЦІЯ without claiming cost.
- **Reconciliation.** It keeps state, failure code, response ID and submission state. The audit row holds operator, resolution and evidence, and UPDATE/DELETE on it fail. Reconciliation refuses: already reconciled, non-UNCERTAIN runs, unknown runs, invalid note or resolution.
- **Stale workers.** A worker stuck in a deadline cancel cannot finalize after a newer worker completed the run. A worker whose late submit returns cannot overwrite a run that another worker made UNCERTAIN and the operator reconciled.
- **Fake provider.** The fake provider echoes bounds after a "restart" (new instance). This test caught a regex escaping defect introduced while editing during this fix, before it reached any commit.

Also fixed: `health.stall.spec.ts` (TRB-010) failed once under load. Ten sequential probes could exceed its 1.5 s connect timeout and open a second connection. The test now uses a 4 s connect timeout with a 15 s test timeout; three consecutive full unit runs passed before the change, and the targeted run passes after it.

Live sample: still **PENDING**.

### TRB-020 authorized live sample (2026-10-19, owner-run, local polling)

Owner-authorized, run once by the owner on a fresh test bot with a dedicated OpenAI project. Evidence below comes from the Telegram conversation, application logs and the local database. No figure was read from OpenAI billing.

**Observed facts**

| Check | Evidence | Result |
|---|---|---|
| Configuration gate | First attempt with an invalid key: run `7dbef1a4-…` FAILED / `OPENAI_HTTP_401_invalid_api_key`, no response ID, no retry, failure notice delivered | Pass (not accepted by OpenAI) |
| Real provider integration | Run `0241a554-c529-4ff3-94a7-d5e61c6800d5` SUCCEEDED / FOUND in 22.4 s. Model requested `gpt-5.5`, returned `gpt-5.5-2026-04-23`, reasoning `low`. `background: true`, `store: false`, `tool_choice: "required"` | Pass |
| Echoed bounds | Report accepted, so the response echoed `max_output_tokens=4000`, `max_tool_calls=3`, `tool_choice=required` and the web search tool (otherwise `BOUNDS_NOT_CONFIRMED`) | Pass (echo only; see tool limit below) |
| Usage recorded | 23,806 input tokens (0 cached), 1,245 output tokens including 519 reasoning tokens; 2 url_citation annotations; 44 consulted URLs (`action.sources`) | Recorded |
| Report delivery | Acknowledgment and REPORT delivered (1 part each, 1 attempt); clickable `[1]` citation next to the claims; no simulation banner | Pass |
| `/result` | RESEND delivery SENT, part content hash identical to the REPORT part. Still 2 runs total; the run's usage, tool count and `updated_at` unchanged | Pass (no new research run created) |
| Tool limit | `tool_call_count` = 4 web_search_call output items with `max_tool_calls` = 3 echoed | **Unresolved** (see below) |

**Cost estimate** (not billing evidence): about $0.19–0.20 at the gpt-5.5 list prices checked on 2026-10-19. That is input $5/1M ≈ $0.12, output $30/1M ≈ $0.04, and web search $10/1k calls × 3–4 ≈ $0.03–0.04. Whether all four items were billed calls is unknown.

**Not verified**
- **Football facts.** The fixture (FC Barcelona – Deportivo Alavés, 2026-10-31 22:00 Kyiv) has not been checked independently against the official page.
- **Unsupported claim.** The report states that the LALIGA site also confirms the fixture, but no citation annotation supports that statement.
- **Cosmetic issues.** An extra blank line after the header and an English "Limitations" heading.
- **Absence of a second OpenAI request after `/result`.** It is shown by the database. The owner's dashboard check was not recorded here.

**Tool-limit discrepancy (4 output items vs `max_tool_calls = 3`)**
- **What is known.**
  - The API reference says `max_tool_calls` is "the maximum number of total calls to built-in tools that can be processed in a response… Any further attempts to call a tool by the model will be ignored".
  - `web_search_call` items have statuses `in_progress | searching | completed | failed | incomplete` and actions `search | open_page | find_in_page`, so each of these actions is its own output item.
  - The pricing page charges "$10.00 / 1k calls" for web search, but does not define a "call" or mention `open_page`/`find_in_page`.
  - The 44 stored URLs come from `action.sources`, which only `search` actions carry, so at least one `search` action occurred.
- **What is unknown.**
  - The status and action of each of the four items, so whether a fourth item was an ignored attempt, a non-search action, or an executed search.
  - How many searches were billed.
  - Whether the limit was enforced. The echoed value proves only that the request carried it.
- **Can existing evidence resolve it?** No. Per-item metadata was not stored for this run, so its telemetry is `not_recorded`, and the response was created with `store: false`. New instrumentation cannot reconstruct it. Only billing data attributable to this response could settle the billed count.

### TRB-020 tool telemetry follow-up (2026-10-19)

Instrumentation only; no paid call and no Telegram message.

- **What is stored.** `research_tool_item` keeps one row per provider response ID and tool item ID: item type, latest reported status and `action.type` (verbatim, `null` when not reported), observation count, and first/last seen. Items without an ID are keyed `missing-id:<position>` and flagged. No queries, URLs, page content or raw responses are stored.
- **When it is written.** Rows are written in fenced transactions for every snapshot: submit, each poll, and the cancellation result. `research_run.tool_telemetry_version = 1` marks runs with telemetry. Earlier runs keep `NULL` (`not_recorded`), and nothing is backfilled.
- **Field meaning.** `tool_call_count` keeps its historical meaning: web_search_call output items in the final snapshot. Billable search count is always reported as unknown.
- **Inspection.** `npm run ops:tool-telemetry -- --run <id>` (read-only). For run `0241a554-…` it reports `telemetry: not_recorded`, `webSearchCallOutputItemsFinalSnapshot: 4`, `billableSearchCount: null`.

| Check | Command | Result |
|---|---|---|
| Migration | `prisma migrate dev --create-only`, `migrate deploy`, `migrate status`, `migrate diff --exit-code` against the dev DB | `20261019103519_trb_020_tool_item_telemetry` applied; "up to date"; "No difference detected" (exit 0). One earlier diff invocation with suppressed output exited 1; it was rerun twice and returned 0, cause not determined |
| Static checks | `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run prisma:validate` | Pass |
| Unit tests | `npm test` | 114 passed (10 files) |
| Integration tests | `npm run test:integration` | 61 passed (6 files); 0 disposable databases left |
| Build | `npm run build` | Pass |

Telemetry tests:
- **Unit (mapping).** Mixed `search`/`open_page`/`find_in_page` items; missing or unknown status and action kept as `null` or verbatim; a missing item ID; no query, URL or pattern retained.
- **Integration (real PostgreSQL).**
  - The same item across three polls is counted once and progresses `in_progress` → `searching` → `completed`.
  - `failed`/`incomplete` items stay distinguishable from completed ones.
  - An item omitted by a later snapshot is retained, and reported values are not overwritten by missing ones.
  - Telemetry survives a worker takeover, and the stale worker's late observation is rejected by fencing.
  - Telemetry persists for an execution that ended UNCERTAIN, including the cancellation snapshot.
  - A legacy run without telemetry reports `not_recorded` (unknown, not zero); a rejected submission reports recorded with 0 items.

### TRB-020 diagnostic live run and dashboard evidence (2026-10-19)

The owner started a second live run with the telemetry build: same prompt, model and bounds. The owner also shared an OpenAI Usage dashboard screenshot. Nothing below was read through an authenticated API by the implementation.

**Dashboard evidence for run `0241a554-…`** (owner screenshot: Usage, "Default project", "All API keys", week to date, taken after the second run)
- **Figures shown.** Total spend $0.20; total tokens 23,806; total requests 1; "Responses and Chat Completions: 1 requests, 23.806K input tokens"; "Web Searches: 4 requests"; October spend $0.20 / $100.00.
- **Attribution.** The figures fit run `0241a554-…` only: 23,806 input tokens and 1 request match it exactly. The invalid-key attempt has no usage. The second run (23,358 input tokens, submitted 10:54:57 UTC) was not yet reflected, consistent with dashboard ingestion delay.
- **Interpretation.** The project's usage metering recorded **4 web search requests** for a response whose request carried `max_tool_calls = 3`.
- **Cost consistency.** $0.20 is consistent with 4 metered search calls: input $0.119 + output $0.037 + 4 × $0.01 = $0.196. With 3 calls it would be $0.186; the dashboard's rounding does not allow a firm distinction from cost alone.
- **Still unknown.**
  - Which actions the 4 metered requests were; per-item metadata was not recorded for that run.
  - Whether "Web Searches requests" equals billed calls one-to-one.
  - Whether the fourth was an ignored attempt or an executed action.
- **Not verified.** The screenshot does not show whether "Enforce a hard limit" is on. "$0.20 / $100.00" could be an alert threshold or a hard limit.

**Diagnostic run `1f9d1736-eb9c-4251-b333-39f9b9944352`** (database and `npm run ops:tool-telemetry`)
- **Execution.** SUCCEEDED / FOUND in 22.3 s; model `gpt-5.5-2026-04-23`, reasoning `low`; bounds 4000 / 3 echoed.
- **Usage and citations.** 23,358 input and 1,222 output tokens (447 reasoning); 4 citations to 3 distinct sources (FC Barcelona schedule, LALIGA club page, LALIGA matchday page); 42 consulted URLs.
- **Delivery.** ACK and REPORT SENT on the first attempt.
- **Telemetry.** Recorded: **3 observed tool items**, all `completed` — 2 `search` and 1 `open_page`. `tool_call_count` = 3; no items without provider ID.
- **Observation timing.** Every item was first and last seen in the same snapshot (observations = 1). The earlier in-progress polls exposed no tool items, so no intermediate status was observed.
- **Evidence it adds.** An `open_page` action appears as a separate `web_search_call` item and counts toward the observed items. Here the observed items equal `max_tool_calls` (3).
- **What it does not show.** How `open_page` is metered, or what the 4 items of the first run were.

**Pending decisive check (no new run needed).** Once the dashboard includes the second run, the totals should be 2 requests and 47,164 input tokens. "Web Searches" then shows whether the 3 observed items were all metered (total 7) or only the 2 `search` actions (total 6). Any other value, or totals that do not match, leaves attribution unresolved.

**Status.** Tool-limit verification remains **unresolved**. The first run had 4 observed output items and 4 metered web search requests with `max_tool_calls = 3`, so the echoed bound alone must not be treated as an enforced cap on metered web searches. Football facts are not independently verified.

## Release checklist

- Exact model/tool compatibility verified in official docs and an authorized sample.
- Bounded request settings/pricing understood; user/global budgets explicitly configured.
- Two-user isolation and all critical persistence/recovery scenarios pass.
- Migration, restart, webhook secret, health checks and backup/restore verified.
- Secrets/content excluded from logs; retention and unknown-outcome runbook documented.
- Operator accepts proposed defaults and understands delivery duplicates/unknown spend limitations.
- Record test evidence and remaining limitations; owner accepts beta release.

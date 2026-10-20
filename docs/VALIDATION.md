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

### TRB-020 acceptance (2026-10-19)

The owner accepted TRB-020 after review of commit `8e1591a3ea356305b6120920872444bcfcd233da` and the live evidence above. The sections above are left as recorded.

- **What acceptance covers.** The implementation and the observed live behaviour: provider integration, stored report, delivery and `/result`.
- **What it does not cover.** Acceptance does **not** verify that `max_tool_calls` caps billable searches, and it does not establish an exact spending ceiling. Tool-call metering remains **unresolved**.
- **Clarification of the pending dashboard check** (the sections above are unchanged). A "Web Searches" total of 7 or 6 would only show which observed metering total the dashboard reports, all observed items or only the `search` actions, for these two runs. It would not independently prove which actions OpenAI bills, or how. That requires billing documentation or invoice-level evidence.
- **Consequence for TRB-050.** Budget reservations must not assume `max_tool_calls` is a hard cap on billable searches. Unknown usage and potential overruns need an explicit policy (docs/BACKLOG.md, TRB-050). Live research stays administrator-only until then (TRB-030).

### TRB-030 evidence (2026-10-19, local Windows 11, Node 24.19.0, PostgreSQL 17)

Mock validation only: fake research provider, recording Telegram sender, real disposable PostgreSQL. No OpenAI request, no Telegram message, no deployment. Behaviour: docs/IDENTITY.md.

| Check | Command | Result |
|---|---|---|
| Static checks | `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run prisma:validate` | Pass |
| Unit tests | `npm test` | 148 passed (11 files) |
| Integration tests | `npm run test:integration` | 81 passed (8 files, including all TRB-010/020 suites); 0 disposable databases left |
| Build | `npm run build` | Pass |
| Migration, dev DB | `prisma migrate deploy`, `migrate status`, `migrate diff --exit-code` | `20261019111654_trb_030_identity` applied without reset; "up to date"; "No difference detected" (exit 0) |
| Dev data preserved | MD5 over all rows of `research_run`, `delivery`, `delivery_part`, `research_tool_item` (new columns excluded) before and after the migration and after bootstrap; reconciliation row count | Identical. The 3 TRB-020 runs were linked to the configured administrator at startup (`ADMIN_GRANTED`, `linkedRuns: 3`); the application ran with `TELEGRAM_MODE` and `RESEARCH_MODE` disabled |
| Mutation check | Each guard removed in turn, TRB-030 suites rerun (script outside the repository) | 10 of 11 mutations caught: worker eligibility gate, delivery suppression, single-redemption condition, expiry condition, `/result` owner scope, live admin-only admission, suspension cancelling queued runs, redemption by suspended users, in-flight suspension check, and both revision checks together. Removing only the router's revision check is not detected, because the conditional update in `confirmTimeZone` enforces the same rule (defence in depth) |

Scenarios (`test/integration/identity.int-spec.ts`, `identity-migration.int-spec.ts`, `src/identity/identity.spec.ts`, `src/telegram/ingress.spec.ts`):
- **Bootstrap.**
  - Idempotent on repeat, with no invitation used.
  - A removed ID loses the role. A re-added suspended user stays suspended and cannot act.
  - A configured administrator onboards through `/start` and the time-zone button.
  - A removed administrator without an invitation has no account.
- **Invitations.**
  - End-to-end onboarding with a typed zone (`america/new_york` normalised and confirmed by button) and an invalid zone rejected. Fake research then succeeds in the user's zone.
  - The inviting administrator is notified with the Telegram ID only.
  - The token is absent from `invitation`, `delivery_part` (placeholder only), `telegram_update`, `audit_event`, `app_user` and the logs.
  - Malformed, unknown, expired and consumed tokens get one identical reply and create no user.
  - Five rounds of two concurrent redeemers each produce exactly one user.
  - Members, administrators, suspended users and group messages never consume an invitation; an unused invitation still works afterwards, granting MEMBER only.
  - Without `INVITATION_TOKEN_SECRET`, creation is refused.
- **Duplicates.** Replayed or concurrent identical updates create one invitation, one user, one redemption audit, one notice, one confirmation and one run; a second press after completion changes nothing.
- **Restart.** Onboarding resumes in a new application instance, and a button issued before the restart still confirms.
- **Callbacks.** These change nothing and create no message:
  - stale revision;
  - invalid zone (`EST`);
  - injected `;owner=` suffix;
  - unknown prefix;
  - a press by a sender without an account;
  - a press in a group, or in a chat that is not the presser's.
- **Ownership.**
  - `/result` for another user's run, for a nonexistent run and by an administrator for a member's run all get "Запуск не знайдено." and create no RESEND.
  - A member's `/admin suspend` and `/admin invite` look like unknown commands and change nothing.
  - A foreign run ID is not recorded in the inbox.
  - Unregistered senders get only the invitation-required reply for every command.
- **Suspension.**
  - Queued runs become CANCELLED and their acknowledgment SUPPRESSED, with no provider call; further `/research`, `/result` and `/start <token>` are refused.
  - Repeated suspension is idempotent; administrators and unknown IDs are refused; the audit holds counts only.
  - Reactivation delivers no backlog.
  - Suspension committed after admission without cancellation: the worker cancels before submission.
  - Pending report: SUPPRESSED, and the stored result is kept.
  - In-flight request: provider cancellation is requested; confirmed gives CANCELLED and keeps the response ID; a failed cancellation gives UNCERTAIN `SUSPENDED_CANCEL_UNCONFIRMED`; nothing is delivered.
- **Live before TRB-050.**
  - A member's live request is refused, with no run and no simulated fallback.
  - A member's queued live run is CANCELLED `LIVE_NOT_PERMITTED` with zero submissions.
  - An administrator's live run proceeds.
- **Migration.** A database with TRB-020 records was migrated up to TRB-020, then TRB-030 was applied:
  - All rows of six tables are unchanged, and no owner is assigned by the migration.
  - Bootstrap links only the configured administrator's runs, with row content unchanged apart from `user_id`; reconciliation is still append-only and owners cannot be reassigned.
  - Records used:
    - SUCCEEDED live run with report, resend and tool items;
    - reconciled UNCERTAIN run;
    - unreconciled UNCERTAIN run of a former administrator;
    - SUCCEEDED and QUEUED fake runs;
    - status delivery.
  - The former administrator's unreconciled live UNCERTAIN run still blocks live work.
  - The unowned QUEUED run is CANCELLED `OWNER_UNRESOLVED` with zero submissions, and its notice is suppressed.
  - The administrator resends a TRB-020 report after onboarding.
  - The former administrator has no access until invited; redemption then links exactly their runs.
- **Unit.**
  - Authorization matrix; time-zone normalisation (accepts region names and UTC; rejects `EST`, `est5edt`, `GMT+3`, offsets and unknown zones).
  - Callback data bounds and forged payloads; token shape and hashing; unsafe Telegram IDs rejected rather than rounded.

Found and fixed while testing:
- `Intl` accepts `EST` as `America/Panama`, so only region names and UTC are accepted.
- `Intl` spells `Europe/Kyiv` as `Europe/Kiev`, so stored spelling follows the runtime list or the user's title-cased input.
- The cancellation notice of an unowned run was delivered to its original chat; deliveries of unowned runs are now suppressed.

Not run:
- **Docker image smoke.** The Dockerfile and dependencies are unchanged and the new variables are optional.
- **CI on a hosted runner.**
- **Live Telegram check of buttons, deep links and callback acknowledgements.** It needs owner authorization and real messages; `answerCallbackQuery` and `reply_markup` are verified only against the grammY types.

### TRB-030 review fixes (2026-10-19, reviewed commit 6540e6a)

Finding 1: reactivation could release accumulated reports. Finding 2: revoked account access did not block report delivery. Mock validation only: fake provider, recording Telegram sender, real disposable PostgreSQL. No OpenAI request, no Telegram message, no deployment. Behaviour: docs/IDENTITY.md, "Durable suppression", "Reactivation and explicit resend" and "Delivery-time access".

Root causes:
1. **Finding 1.** Suppression existed only as the state of deliveries that were waiting at suspension time, plus a check of the owner's *current* status at send time.
   - A report created later by in-flight research, or the remaining parts of a delivery already `SENDING`, were not marked.
   - After reactivation the status check passed again.
   - The fix stores a durable decision on runs (`delivery_suppressed_at`) and deliveries (`suppressed_at`). Reactivation never clears it. Report creation reads it under the run's row lock; the delivery worker reads it when it marks each part `SENDING`, and when it recovers expired leases.
2. **Finding 2.** The delivery worker checked only `user_id IS NULL` and `status = SUSPENDED`. It now applies the centralized `runDeliveryDenial` (account access with the current configuration) before each run-related part.

| Check | Command | Result |
|---|---|---|
| Reproduction before fix | new `test/integration/identity-delivery.int-spec.ts` run with `src/` from 6540e6a (`git stash`) | 7 failed, 1 passed. The passing test checks preserved behaviour: an invited former administrator still receives their reports |
| Static checks | `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run prisma:validate` | Pass |
| Unit tests | `npm test` | 149 passed (11 files) |
| Integration tests | `npm run test:integration` | 90 passed (9 files); 0 disposable databases left |
| Build | `npm run build` | Pass |
| Migration, dev DB | `prisma migrate deploy`, `migrate status`, `migrate diff --exit-code` | `20261019120153_trb_030_durable_suppression` applied without reset; "up to date"; "No difference detected" (exit 0). The dev DB had no suspended users, no suspension events and no `SUPPRESSED` deliveries, so the backfill changed no rows |

Regression scenarios (`identity-delivery.int-spec.ts`; synchronisation through provider and sender hooks and PostgreSQL lock waits, no sleeps):
- **Finding 1.**
  - **Cancellation returns completed.** The owner is suspended during an in-flight run, and the cancellation answer is `completed`. The report, response ID and usage are stored. After reactivation the REPORT stays `SUPPRESSED`, and zero reports are sent.
  - **Explicit resend.** `/result` after reactivation sends exactly the stored parts as a new `RESEND`; the REPORT stays `SUPPRESSED` and there is no new submission.
  - **New research.** Research admitted after reactivation is delivered (`SENT`).
  - **Completion seen by the poll.** Suspended, then the poll sees completion and the owner is reactivated before delivery: the report is suppressed.
  - **Multipart send in flight.** Suspension and reactivation happen while Telegram handles part 1. Part 1 stays `SENT` with its message ID; the remaining parts stay `PENDING`, the delivery becomes `SUPPRESSED`, and one report part is sent in total.
  - **Restart.** One delivery is between parts and another has part 0 `SENDING`; suspension, then reactivation; leases expire and a new application instance recovers. The first becomes `SUPPRESSED` with its `SENT` part kept. The second becomes `UNKNOWN` with its part `UNKNOWN`, never retried. Zero report sends.
  - **Concurrent suspension and report creation.**
    - An external transaction holds the report's unique slot, so the worker's completion transaction pauses while holding the run row.
    - A second application instance's suspension waits on that row; two lock waiters are observed in `pg_stat_activity`.
    - Then the slot is released. The report is `SUPPRESSED` after reactivation and nothing is sent.
- **Finding 2.**
  - **No invitation.** A former administrator without an invitation, with configuration excluding them: the pending REPORT, the queued RESEND and three run-related status messages all become `SUPPRESSED / ACCESS_REVOKED`, and zero messages are sent. The invitation-required reply to `/start` is still sent.
  - **Stale role.** The same with the stored role reset to `ADMIN`: nothing sent.
  - **Invited former administrator.** Becomes MEMBER and receives the report and the resend.
  - **Existing protections.** Unresolved-owner and suspended-owner tests in `identity.int-spec.ts` and `identity-migration.int-spec.ts` still pass.
- **Migration** (`identity-migration.int-spec.ts`).
  - The TRB-020 → TRB-030 test now applies all later migrations; its rows are unchanged.
  - New backfill test on a database at the first TRB-030 migration: the decision is recorded only for a currently suspended user's running run and `SENDING` delivery. An already `SUPPRESSED` delivery gets its timestamp. An active user's work is untouched, no state changes, and clearing the decision of a `SUPPRESSED` delivery violates `delivery_suppressed_has_decision`.
- **Unit.** `runDeliveryDenial`: unresolved, suspended, revoked (stale role or not), an invited former administrator, an administrator, and onboarding not required.

Also found while testing:
- **Request timing.** supertest sends a request only when it is awaited, so the race test starts it explicitly.
- **Shared pool.** In one application instance, a second interactive transaction did not reach PostgreSQL while the first was waiting on a lock. Both pool connections were checked out, but only one appeared in `pg_stat_activity`. The race test therefore suspends through a second instance, and the concurrent-redemption test in `identity.int-spec.ts` now uses two instances. The cause inside Prisma or the adapter was not investigated. Correctness does not depend on it, but an earlier single-instance concurrency test may have been serialised in the application rather than in PostgreSQL.

Remaining limitations:
- **External send race.** A part already marked `SENDING`, and handed to Telegram, may be delivered after a suspension; it is not retracted. Its outcome is recorded as `SENT` or `UNKNOWN`.
- **Earlier suspensions.** Suspensions that were already reactivated before the migration left no per-work evidence and are not reconstructed (docs/IDENTITY.md, "Legacy limitation").
- **Not run:** Docker smoke (Dockerfile and dependencies unchanged), CI, and live Telegram.

### TRB-030 acceptance (2026-10-19)

The owner accepted TRB-030 after review of commit `cce6affda159b732b8702b329af2aad7923e97c2`: implementation 6540e6a plus the review fixes recorded above. The sections above are left as recorded.

**Accepted limitation.** The durable-suppression migration does not reconstruct the effects of suspensions that were already reactivated before it ran (docs/IDENTITY.md, "Legacy limitation"). The owner's database has no historical suspended users or affected deliveries, so no further historical backfill is required. The migration is not claimed to handle every historical state.

Durable suppression and the current-access check at delivery remain in the code. Their regression suites (`identity-delivery.int-spec.ts`, `identity.int-spec.ts`) pass with TRB-040.

### TRB-040 evidence (2026-10-19, local Windows 11, Node 24.19.0, PostgreSQL 17)

Mock validation only: fake research provider, recording Telegram sender, real disposable PostgreSQL. No OpenAI request, no Telegram message, no deployment. Behaviour: docs/TASKS.md.

| Check | Command | Result |
|---|---|---|
| Static checks | `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run prisma:validate` | Pass |
| Unit tests | `npm test` | 158 passed (12 files) |
| Integration tests | `npm run test:integration` | 110 passed (10 files, all earlier suites included); 0 disposable databases left |
| Build | `npm run build` | Pass |
| Migration, isolated DB | integration global setup (`prisma migrate deploy` on a fresh database); `identity-migration.int-spec.ts` applies every migration after TRB-020, including `20261019185534_trb_040_tasks`, to a database with TRB-020 records | Pass; all rows of the six TRB-020 tables unchanged |
| Migration, dev DB | `prisma migrate deploy`, `migrate status`, `migrate diff --exit-code` | Applied without reset; "up to date"; "No difference detected" (exit 0). Existing rows kept: 3 runs, 1 user, 10 deliveries |
| Mutation check | Each guard removed in turn, `tasks.int-spec.ts` and task unit tests rerun (script outside the repository) | 11 of 11 caught. Guards: edit-save revision condition, draft-button version check, task owner scope, exclusion of deleted tasks, task-button revision check together with the delete and pause conditions, draft expiry, Save ending the draft, schedule-kind field clearing, a deleted edit target, and the access recheck inside the task services. The last one initially survived, because the router checks first; a test calling the services directly was added |

Scenarios (`test/integration/tasks.int-spec.ts`). After every test there are zero research runs and zero provider submissions in every application instance used:
- **Creation.**
  - Manual, daily and weekly tasks through the steps, including the empty `/tasks` state and the "+ Нове завдання" button; a typed zone (`America/New_York`).
  - The preview shows the exact configuration, with HTML in the prompt escaped; the stored fields are checked.
- **Back and Cancel.**
  - Back keeps values ("Зараз: 10:00", the ✓ weekday).
  - Switching weekly to daily drops the weekday, and switching to manual drops the time.
  - "Залишити як є" keeps the time; Cancel and `/cancel` save nothing, and the first step has no Back button.
- **Validation.** Empty, overlong and multi-line names; an overlong prompt; text at a button step; a forged weekday `w8`; invalid times (`24:00`, `9.00`, text) and zones (`EST`, `Mars/Olympus`, `+03:00`). Each keeps the step and gives a clear message.
- **Duplicates.** The same Save update twice plus a second press from another application instance, run concurrently, then another press: exactly one task and one `TASK_CREATED`.
- **Open drafts.** `/new` with an open draft offers Continue or "Відкинути й почати нове"; nothing is discarded silently.
- **Restart.** A creation draft and an edit draft each survive a restart and are completed in a new instance.
- **Expiry.** An expired draft is neither saved (old Save button) nor resumed (text); the user is told, and `/new` starts afresh. Rejected input does not extend the expiry; an accepted step extends it to 24 h.
- **Stale buttons.** An older step's button, a future version and a button of an ended draft change nothing.
- **Editing.**
  - The saved task is unchanged until Save; the edit applies only its section and increments the revision.
  - Cancel and expiry of an edit leave the task unchanged.
- **Stale edit.** A task paused after the edit started: Save is refused with the stale message, and the pause is kept.
- **Overlapping changes.**
  - An external session holds the user's identity advisory lock until an edit Save (instance 1) and a stale-card Pause (instance 2) both wait at PostgreSQL; two lock waiters are observed.
  - Exactly one change is applied, the revision becomes 2, and the other is refused as stale.
- **Pause and resume.** Repeated and stale presses change nothing; resume increments the revision.
- **Limits.** Active and saved limits apply at save, resume and `/new`.
- **Delete.**
  - A stale confirmation (the task changed after the request) does not delete.
  - Confirmed deletion soft-deletes (`DELETED`, `deleted_at`).
  - An open edit draft of the deleted task ends safely. View, resume, edit and confirm on it answer "Завдання не знайдено.".
- **Ownership.**
  - User B gets "Завдання не знайдено." for every operation on A's task and on a nonexistent ID.
  - A's draft buttons pressed by B do nothing to A's draft.
  - B's list is empty, and nothing of A's appears in B's messages.
- **Access.** Each of the following changes no draft or task:
  - a suspended member's commands, text and draft button;
  - an unknown sender's commands (invitation-required reply only);
  - group commands and a group button press;
  - a direct call of each task service with a suspended user (defence in depth).
- **Task zone.** Changing the user's zone does not change an existing task or its card. Editing the schedule suggests the task's zone, and a new task suggests the user's.
- **Logs.** Task names and prompts do not appear in logs; reason codes do.

Unit (`src/tasks/tasks.spec.ts`):
- **Dialog transitions** for every kind; Back keeps values; the kind change clears fields; per-step errors; edit sections.
- **Configuration checks.** Partial or tampered configurations are refused; a manual schedule never keeps a time or weekday.
- **Input rules.** Name, prompt and time rules.
- **Callback data.** Payloads stay within 64 bytes; forged payloads are rejected.
- **Escaping and splitting.** HTML is escaped, and long previews are split between graphemes without broken entities.
- **Card wording.** Cards show the task zone and no invented next run.

Remaining limitations:
- **Not executed yet.** Schedules are stored configuration only: no next occurrence is computed (TRB-070), and there is no task "Run now" (TRB-050/060). Pausing or deleting cancels no queued work, because none exists yet.
- **Settings.** The user's default zone cannot be changed from Telegram (`/settings` is not implemented); the independence test changes it directly in the database.
- **Abandoned drafts.** Expired drafts nobody touches stay in `task_draft` until the user's next interaction (retention: TRB-090).
- **Not run:** Docker smoke (Dockerfile and dependencies unchanged; two new optional variables with defaults), CI, live Telegram (inline buttons, multi-part previews).

### TRB-040 review fix (2026-10-19, reviewed commit ebff202)

**Finding.** Old buttons could act on a different draft.

**Root cause.** Draft buttons carried only `d:<version>:<op>`, and every new draft starts at version 0. `onDraftAction` compared the button's version with whatever draft was currently open, so a button of a cancelled draft A acted on a later draft B at the same version.

**Fix.** Draft buttons now carry the draft's persistent ID: `d:<draft id>:<version>:<op>`, at most 51 bytes of Telegram's 64.
- **Order of checks.** `onDraftAction` checks the ID against the user's own open draft before expiry cleanup, the version check and step applicability. A mismatch is `IGNORED / CALLBACK_STALE` with no write.
- **Legacy payloads.** The version-only form no longer parses (`CALLBACK_UNKNOWN`).
- No schema change: the existing `task_draft.id` is used.

| Check | Command | Result |
|---|---|---|
| Reproduction before fix | new `test/integration/task-draft-identity.int-spec.ts` against the code of ebff202 | 7 failed, 2 passed. The 2 passing tests check behaviour that must be preserved: restart, and concurrent Save |
| Static checks | `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run prisma:validate` | Pass |
| Unit tests | `npm test` | 159 passed (12 files) |
| Integration tests | `npm run test:integration` | 119 passed (11 files, all earlier suites included); 0 disposable databases left |
| Build | `npm run build` | Pass |

Regression scenarios (real PostgreSQL). For each rejected press, the current draft's ID, data, step, version and expiry are compared before and after (unchanged). Each also leaves no task, no research run and no provider submission.
1. Cancel from draft A does not delete draft B at the same version 0.
2. Save from A does not save B at PREVIEW, both at version 4; B's own Save then creates exactly one task.
3. A's schedule-kind button and Back do not change B at the same version and step.
4. A's old Продовжити and Відкинути (conflict dialog) do not resume or replace B at the same version.
5. Another user's Cancel button does not touch the caller's draft at the same version, nor the other user's draft.
6. Legacy `d:<version>:<op>` payloads (Save, Cancel, Back, Resume, Discard) are rejected as `CALLBACK_UNKNOWN`.
7. A mismatched button neither removes nor extends an expired replacement draft. The draft's own button then reports the expiry and ends it.
8. A valid button issued before a restart works in a new application instance.
9. The same Save update twice, plus a press from a second instance concurrently, plus a later press: exactly one task.

Unit: the new draft format round-trips, and payloads stay within the size limit. Rejected: the legacy form, an upper-case, truncated, extended or hyphen-less ID, a non-UUID, a missing operation, a leading-zero version, an extra suffix and weekday `w8`. The formatter refuses a non-UUID ID.

Not run: Docker smoke (no configuration or dependency change), CI, live Telegram.

**Limitation.** Buttons sent before this fix stop working; users get the stale-button acknowledgement and continue with `/new` or `/cancel`. No real users had such buttons: Telegram was disabled outside tests.

### TRB-040 acceptance (2026-10-19)

The owner accepted TRB-040 after review of commit `cf8637b4b04eb94e197177acaa858017fa96a78f`: implementation ebff202 plus the review fix recorded above. The sections above are left as recorded.

### TRB-050 evidence (2026-10-19, local Windows 11, Node 24.19.0, PostgreSQL 17)

Mock validation only. Scripted providers stand in for OpenAI: no network call, no Telegram message, no deployment. Prices are synthetic (`test/support/live-env.ts`); they are not OpenAI prices and no real price was configured. Behaviour: docs/ACCOUNTING.md.

| Check | Command | Result |
|---|---|---|
| Static checks | `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run prisma:validate` | Pass |
| Unit tests | `npm test` | 178 passed (13 files) |
| Integration tests | `npm run test:integration` | 150 passed (12 files, all earlier suites included); 0 disposable databases left |
| Build | `npm run build` | Pass |
| Migration, isolated DB | global setup (`migrate deploy` on a fresh database); `identity-migration.int-spec.ts` applies all migrations after TRB-020 to a database with TRB-020 records | Pass. Rows unchanged apart from the new columns. No reservation, ledger entry or outbox event is invented. Admission days are backfilled from `created_at`. A legacy QUEUED run is cancelled `ADMISSION_EVIDENCE_MISSING` with zero submissions and no reply |
| Migration, dev DB | `migrate deploy`, `migrate status`, `migrate diff --exit-code` | Applied without reset; "up to date"; no difference (exit 0). 3 historical runs got admission days and no accounting rows; 10 deliveries kept |
| Migration correction | — | The first version of `20261019194156_trb_050_admission_accounting` added the suppression-reason check before its backfill. That would fail on a database with suppressed runs, and the migration test caught it. The statement order was corrected before release. The migration had been applied only to the local dev DB, which had no such rows, so the resulting schema is identical; its `_prisma_migrations` checksum was updated to the corrected file so that `migrate dev` does not flag it |
| Operator command | `node dist/ops/accounting.js --list` against the dev DB; missing arguments | `[]`, exit 0; usage message, exit 2 |
| Mutation check | Each guard removed in turn, `accounting.int-spec.ts` and `identity-migration.int-spec.ts` rerun (script outside the repository) | 8 of 8 caught after one test was added. Guards: user budget, global budget, settlement idempotency, unknown cost kept at the reservation, ambiguous outcome not released, reservation required before submission, legacy queued runs gated, cancelled runs excluded from quotas. The last one initially survived; the test "does not count a run cancelled before submission against the daily quota" was added and catches it |

Scenarios (`test/integration/accounting.int-spec.ts`, real PostgreSQL). Concurrency tests hold the global admission advisory lock until the expected number of sessions wait at PostgreSQL (`pg_stat_activity`), using separate application instances.
- **Admission evidence and settlement.**
  - Admission writes the reservation (284 000 µUSD), its policy inputs and pricing version, the run's UTC periods, the snapshot reference and one pending outbox event.
  - Execution consumes the event and settles with estimate 14 800 and uncertain search hold 50 000. The ledger is RESERVE then SETTLE and sums to the exposure.
  - Replayed release and settlement change nothing.
- **Missing configuration.** A missing user or global budget, pricing label, output rate or search allowance each refuses live admission with its reason: no run, reservation or outbox event, and zero submissions. So do an unmapped model and a pricing label reused with different rates.
- **Pricing snapshots.** A run admitted under `synthetic-test-1` is settled by a worker configured with `synthetic-test-2` and higher prices, at its own rates; its policy is unchanged. A new run uses the new version.
- **Live restriction and simulated runs.** A non-administrator's live request is refused with no reservation. Simulated runs create no reservation, `/usage` labels them as simulation, and they do not block a later live admission.
- **Capacity under overlap.**
  - User budget 0.6: three overlapping requests from one user give exactly 2 runs and reservations, and 1 `USER_BUDGET_EXHAUSTED`.
  - Global budget 0.6: four overlapping requests from two users give exactly 2 reservations, a total exposure of 2 × 284 000, and 2 `GLOBAL_BUDGET_EXHAUSTED`.
  - Daily limit 2: three overlapping requests give 2 runs. The active-run and manual-run limits refuse at their bounds.
- **Run now.** The same Run now update twice, plus a press from another instance, all overlapping, then a later press: one run, with the task's prompt, revision and zone in the snapshot. The later press answers `TASK_RUN_ACTIVE`, and the task is unchanged.
- **Lifecycle.**
  - Pausing a task cancels its queued live run: RELEASED exactly once (RESERVE +284 000, RELEASE −284 000), event cancelled, a replayed release is a no-op, the worker finds nothing, and the paused task can be run again.
  - Deleting a task cancels its queued run and its event.
  - Deleting a task during its running request does not cancel the request: the run SUCCEEDED, its report delivery is SUPPRESSED `TASK_DELETED`, and the reservation is SETTLED.
  - A run cancelled before submission stops counting against the daily quota; a submitted run keeps counting.
- **Ambiguous and failed outcomes.**
  - An unknown submission outcome gives UNRESOLVED at the full reservation; a provider refusal (4xx) gives RELEASED.
  - A deadline with failed cancellation gives UNRESOLVED at the full reservation.
  - Missing usage, partial usage and an unmapped returned model are each UNRESOLVED at the full reservation, with the reason in the ledger basis.
- **Overrun.** Usage of 400 000 input and 3 000 output tokens with 9 observed searches is estimated at 914 000 and recorded in full: SETTLE 0 then OVERRUN +630 000. The next admission is refused once the budget (1.00) is exhausted.
- **Resolution.**
  - Research reconciliation with `OPERATOR_ACCEPTED_RISK` leaves the reservation UNRESOLVED and fully exposed.
  - Operator resolution to 120 000 succeeds once and a second attempt is refused; the ledger is RESERVE, UNRESOLVED, RESOLVE and sums to 120 000; the ledger rejects UPDATE.
  - Resolving a run that has not finished is refused.
- **Month boundary.** A run admitted at 2026-10-31T23:59:30Z and settled after midnight keeps every ledger entry in 2026-10. The next run is in 2026-11, and `/usage` for 2026-11 shows only it.
- **Recovery and stale workers.**
  - After a restart between admission commit and execution, the run executes exactly once in a new instance.
  - A stale worker returning a large failed response after a takeover writes nothing: one SETTLE, from the newer worker.
- **Isolation and free operations.**
  - `/usage` shows each user's own amounts only.
  - Run now on another user's task gives `TASK_NOT_FOUND`.
  - `/result`, `/new` and `/tasks` add no ledger entries, reservations, runs or submissions.
- **Missing reservation.** A queued live run without a reservation is CANCELLED `ACCOUNTING_MISSING` with zero submissions.

Unit (`src/accounting/accounting.spec.ts`):
- reservation components and rounding up;
- every configuration problem;
- returned-model mapping;
- estimates with cached input, unreported cache and overrun, and unknown (missing or partial usage, unmapped model);
- UTC periods across the month boundary and Kyiv midnight;
- exact USD formatting.

Earlier suites were adapted where TRB-050 changed behaviour:
- live tests use the synthetic accounting configuration;
- the harness sets generous quotas;
- the raw-inserted queued live run in `identity.int-spec.ts` gets an execution event;
- the migration test expects `ADMISSION_EVIDENCE_MISSING` for the legacy queued run.

Remaining limitations:
- **Not a provider ceiling.** Estimates and reservations are not invoices or a provider spending ceiling. Input tokens and searches beyond the allowances are not bounded; billing of `open_page`/`find_in_page` is unverified; the uncertain search hold is released only by an operator.
- **Real prices.** No real prices are configured. The operator must supply and date them.
- **Corrections.** Operator corrections after a resolution are not supported (TRB-090).
- **Live for members** remains disabled; it needs an owner decision.
- **Outbox dispatch.** The outbox is consumed directly by the in-process worker until TRB-060.
- **Not run:** Docker smoke (no Dockerfile or dependency change; new optional variables), CI, any live request.

### TRB-050 review fix (2026-10-20, reviewed commit 6ddcc3e)

**Finding.** Partial usage discarded known costs above the reservation.

**Root cause.** `estimateRun` returned `unknown / USAGE_PARTIAL` as soon as the input or output token count was missing, discarding the reported component. `settleRun` then held only the reservation. Example: 1 000 000 reported input tokens at the synthetic $2/MTok cost $2.00, but the run stayed at $0.284 with no `OVERRUN`, and further admissions were allowed.

**Fix** (docs/ACCOUNTING.md, "Partial usage"):
- **Component policy.** Reported components are priced from the run's own snapshot. Each unreported component keeps its own reservation allowance, and the uncovered search allowance stays held. Exposure = max(reservation, known + held), with increases recorded as `OVERRUN`.
- **What is stored.** `estimated_micros` holds the known part and `uncertain_micros` the remainder of the exposure; `/usage` shows them as estimate and unresolved, without double counting.
- **Unchanged:**
  - no usage at all, or an unmapped model, still prices nothing; the model is now checked before any component is priced;
  - complete usage settles as before;
  - settlement stays in the fenced finish transaction.
- **No schema change.**

| Check | Command | Result |
|---|---|---|
| Reproduction before fix | new unit tests and `test/integration/accounting-partial.int-spec.ts` against the code of 6ddcc3e | Unit: 6 failed. Integration: 7 failed, 1 passed (replay, which was already idempotent) |
| Static checks | `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run prisma:validate` | Pass |
| Unit tests | `npm test` | 183 passed (13 files) |
| Integration tests | `npm run test:integration` | 158 passed (13 files, all earlier suites included); 0 disposable databases left |
| Build | `npm run build` | Pass |

Regression scenarios (synthetic prices, scripted responses, real PostgreSQL):
1. **Input known, output missing.** Input 1 000 000 is known ($2.00); output $0.024 and searches $0.06 are held. Exposure is $2.084: UNRESOLVED 0 and OVERRUN +$1.80. The basis lists `unknownComponents: [output]`.
2. **Output known, input missing.** Output 50 000 is known ($0.40); input $0.20 and searches $0.06 are held. Exposure is $0.66, OVERRUN +$0.376.
3. **Known part below the reservation.** Input 1 200 is known ($0.0024): exposure stays $0.284, with no overrun.
4. **Ambiguous outcome.** A deadline with failed cancellation, after polls reported input 1 000 000: UNCERTAIN, UNRESOLVED at $2.084.
5. **User budget.** With a user budget of $2.20, the next admission is refused (`USER_BUDGET_EXHAUSTED`): no new run, reservation, execution event or submission.
6. **Global budget.** With a global budget of $2.20, another user's admission is refused (`GLOBAL_BUDGET_EXHAUSTED`) with the same guarantees.
7. **Replay.** Replayed settlement (ambiguous and terminal) gives `ALREADY_FINAL`; the reservation and ledger are unchanged.
8. **`/usage`.** Shows estimated $2.00, unresolved $0.084, reserved $0.00 and a total of $2.084.
9. **Unit tests.** Both partial directions; the observed searches policy; held allowances when no token count is reported; an unmapped model with partial usage is still unknown.
10. **Existing behaviour.** The existing `accounting.int-spec.ts` scenarios pass unchanged: complete usage, missing usage, partial usage below the reservation, unmapped model, overrun, operator resolution and stale worker.

**Earlier records.** Reservations finalized by the earlier code are not changed automatically; they would need an explicit operator resolution. None exist: TRB-050 is unreleased and the owner's database has no reservations.

**Not run:** Docker smoke (no configuration change), CI, live requests.

### TRB-050 acceptance (2026-10-20)

The owner accepted TRB-050 after review of commit `b6933460a1140d2845d725caf23b3643f70ae4c6`: the implementation plus the partial-usage review fix recorded above. The sections above are left as recorded. Live research remains administrator-only.

### TRB-060 evidence (2026-10-20, local Windows 11, Node 24.19.0, PostgreSQL 17, pg-boss 12.37.0)

Mock validation only. Scripted providers stand in for OpenAI and a recording sender for Telegram: no network call to either, no deployment, no commit. Prices are synthetic. Local `.env` keeps `TELEGRAM_MODE=disabled` and `RESEARCH_MODE=disabled`. Behaviour: docs/QUEUE.md.

| Check | Command | Result |
|---|---|---|
| Static checks | `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run prisma:validate` | Pass |
| Unit tests | `npm test` | 189 passed (14 files) |
| Integration tests | `npm run test:integration` (real PostgreSQL, real pg-boss in each run's disposable database) | 186 passed (14 files: 27 new TRB-060 scenarios, 1 new migration test, all earlier suites); 0 disposable databases left |
| Build | `npm run build` | Pass |
| Dependency | `npm install --save-exact pg-boss@12.37.0` | Pinned; lockfile updated. Engines `node >=22.12.0`; depends on `pg ^8.23.1`, deduplicated with the project's `pg@8.23.1`. ESM-only package loaded from the CommonJS build via `require(esm)`, verified with the compiled output |
| Migration, isolated DB | global setup (`migrate deploy`, then pg-boss schema install); `identity-migration.int-spec.ts` applies all migrations after TRB-020 to a database with TRB-020 records | Pass. One attempt per submitted run, copied from the run's fields. Outcomes: SUCCEEDED with a response ID → PROVIDER_TERMINAL; both UNCERTAIN runs → UNCERTAIN; the queued run gets no attempt. No reservation, ledger entry or outbox event is invented; every run has `current_attempt_no = 1` |
| Migration, dev DB | `migrate deploy`, `migrate status`, `migrate diff --exit-code` | `20261020120000_trb_060_queue_execution` applied without reset; "up to date"; "No difference detected" (exit 0). MD5 over the run evidence (id, state, submission state, response ID, usage, failure code, completion) and over deliveries is identical before and after. Of the 3 historical runs, the 2 SUCCEEDED got PROVIDER_TERMINAL attempts, and the FAILED one (`OPENAI_HTTP_401_invalid_api_key`, SUBMITTING without an ID) got NOT_ACCEPTED. No reservations, ledger entries or outbox events existed or were created |
| Operator command | `node dist/ops/accounting.js --list` against the dev DB | `[]`, exit 0 |
| Mutation check | Each guard removed in turn, `queue-execution.int-spec.ts` rerun (script outside the repository) | 9 of 9 caught after one test was strengthened. Guards: dispatcher skips finished runs; publication inside the transaction; takeover requires an expired lease; fair claim order; budget authorization of a retry; retry limit; shutdown hand-over wake-up; recovery sweep wakes expired leases; retry delay in the claim. The last one initially survived, because no job arrived before the delay. The retry test now wakes the run early and checks that it is re-deferred to the retry time without a submission |
| Docker smoke | `docker build`; container from the production image against a disposable database on the test server, `RESEARCH_MODE=fake`, `TELEGRAM_MODE=disabled`, `BACKGROUND_WORKERS=on`, no credentials; one run inserted as admission writes it (run + `RESEARCH_EXECUTE` event) | Image built. Readiness `{"status":"ok","checks":{"config":"up","database":"up","queue":"up"}}`. pg-boss installed its schema at startup. The run SUCCEEDED through the dispatcher and the pg-boss worker: one attempt (SUBMITTED, PROVIDER_TERMINAL), event dispatched, one `research-execute` job completed. Its report delivery stayed PENDING because Telegram was disabled. `docker stop` ended gracefully in 3 s with exit code 0 and no error log lines. Database dropped afterwards |

Scenarios (`test/integration/queue-execution.int-spec.ts`, 27 tests). Overlap is synchronized deterministically through scripted provider gates, a PostgreSQL row lock held by a separate session, and SQL that moves leases, deferrals and job expiry into the past. No timing-based assertions:
- **Outbox → pg-boss.**
  - Admission committed, process closed before the dispatcher ran: after a restart the event is published once (job ID = event ID) and executed once.
  - A publication inside a transaction that fails before its acknowledgement leaves no job and a pending event. The next dispatch publishes once, and a repeated publication of the same event returns `null` (no second job).
  - With one event row-locked by a third session, two concurrent dispatchers publish the other two once each; after the lock is released, the third is published once. Jobs equal events.
  - Cancelled work (paused task) and a wake-up of a finished run are never published.
- **Duplicate jobs.** Two jobs for a queued run, a duplicate during execution (live lease: no action) and a job for the finished run (no action): one submission, one report delivery, ledger RESERVE + SETTLE, fencing token 1.
- **Crash recovery and fencing.**
  - A worker that died after claiming but before the submission intent: the recovery sweep wakes the run, it is taken over (fencing token 2) and executed once. One attempt, PROVIDER_TERMINAL; reservation SETTLED.
  - A worker frozen inside the provider call, with retries enabled: the takeover records UNCERTAIN `SUBMISSION_INTERRUPTED`; the attempt stays SUBMITTING/UNCERTAIN; the reservation is UNRESOLVED at the full 284 000. When the frozen call then returns a response ID, it is logged but cannot be recorded. No resubmission follows, and live admission is refused.
  - Shutdown while polling: the lease is released with a `SHUTDOWN_HANDOVER` wake-up. A new instance resumes polling the same response ID with zero submissions and no new reservation (ledger RESERVE + SETTLE, one attempt).
  - Stale worker: after a takeover completes the run, the stale worker's late answer writes nothing (one report, one settlement, fencing token 2).
  - pg-boss job expiry during provider work (`supervise` after moving `started_on` back): the redelivered job finds the live lease and does nothing; one submission and one report.
- **Retries and accounting.**
  - Connection failure, timeout and HTTP 500 are never resubmitted with retries enabled: UNCERTAIN, UNRESOLVED.
  - A 429 with the default limit 0: FAILED, NOT_ACCEPTED attempt, RELEASED.
  - With limit 1, a 429 with Retry-After 5 s:
    - the run is requeued as attempt 2 with `next_attempt_at` within 5 s and a new RESERVED reservation, while attempt 1 is RELEASED;
    - an early job does not claim it before the delay;
    - after the delay the identical stored request is resubmitted and SUCCEEDED, with ledger 1 RESERVE, 1 RELEASE, 2 RESERVE, 2 SETTLE;
    - one run counts against the quota.
  - Two refusals with limit 1: FAILED after 2 submissions, both reservations RELEASED at 0.
  - A retry that the global budget no longer allows, after another user's run overran to 2 060 000: FAILED `…;RETRY_REFUSED:GLOBAL_BUDGET_EXHAUSTED`, no second reservation.
  - Pausing a task whose run waits for its retry releases attempt 2's reservation once.
- **Lifecycle while queued.** Pausing or deleting a task after its job was published, and suspending a member after their job was published, gives CANCELLED with the reason, zero submissions and one RELEASE; the late job completes without action.
- **Fairness and capacity.**
  - User A queues 3 runs, then user B queues 1: execution order a1, b1, a2, a3.
  - A capacity-denied job writes a deferred wake-up more than 10 s ahead and is not re-run before then. Completion of the running run makes the wake-up due at once, and the waiting run then succeeds.
  - Simulated work proceeds while an unreconciled live UNCERTAIN run blocks live work.
- **Background workers and shutdown.** With `BACKGROUND_WORKERS=on`, work runs through `boss.work()` and the dispatcher loop. Closing the application while it polls returns within 15 s and hands the run over; a second application completes it with one submission in total and one report.
- **Readiness** reports `queue: up` with no provider or Telegram call.

Other new tests:
- **Unit.** Env validation (queue schema, retry bounds, the HTTP timeout limited to half the lease); 429 classification (retryable only on submit and not for `insufficient_quota`); Retry-After as seconds, milliseconds and an HTTP date; retry delay bounds.

Earlier suites adapted:
- Reservation lookups now address the run's latest attempt.
- Expected readiness bodies include `queue`.
- The migration test ignores the two new run columns.
- The concurrent-worker test waits for the winner's submission as well as the two losing ticks. Their completion order changed, because a capacity-denied job now completes after writing a deferral.
- Operator reconciliation now wakes queued runs, so the reconciliation test resumes queued live work without waiting for the deferral.

Remaining limitations:
- **Exactly-once.** Provider execution is not exactly-once (docs/QUEUE.md, "Guarantees").
- **Concurrency.** One research request runs at a time globally.
- **Shutdown window.** A platform drain window shorter than `OPENAI_HTTP_TIMEOUT_MS + 5 s` can turn an in-flight submission into UNCERTAIN.
- **Resubmission off.** Automatic resubmission is disabled by default.
- **Rollout.** Rollout requires that old and new workers do not overlap.
- **Not run:** CI, any live OpenAI request or Telegram message, Railway deployment.

## Release checklist

- Exact model/tool compatibility verified in official docs and an authorized sample.
- Bounded request settings/pricing understood; user/global budgets explicitly configured.
- Two-user isolation and all critical persistence/recovery scenarios pass.
- Migration, restart, webhook secret, health checks and backup/restore verified.
- Secrets/content excluded from logs; retention and unknown-outcome runbook documented.
- Operator accepts proposed defaults and understands delivery duplicates/unknown spend limitations.
- Record test evidence and remaining limitations; owner accepts beta release.

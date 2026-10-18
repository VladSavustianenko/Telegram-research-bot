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

## Release checklist

- Exact model/tool compatibility verified in official docs and an authorized sample.
- Bounded request settings/pricing understood; user/global budgets explicitly configured.
- Two-user isolation and all critical persistence/recovery scenarios pass.
- Migration, restart, webhook secret, health checks and backup/restore verified.
- Secrets/content excluded from logs; retention and unknown-outcome runbook documented.
- Operator accepts proposed defaults and understands delivery duplicates/unknown spend limitations.
- Record test evidence and remaining limitations; owner accepts beta release.

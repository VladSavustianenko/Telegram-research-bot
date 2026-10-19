# Telegram Research Bot — implementation brief

Version: 1.0 · 2026-10-18 · Documentation package, project foundation (TRB-010, DONE) and first research-to-Telegram slice (TRB-020, ready for review; live sample pending).

Build a private-beta, multi-user Telegram bot that runs user-authored research prompts manually or on a schedule, uses OpenAI web search, and delivers sourced results. Deploy one NestJS application and PostgreSQL on Railway.

## Read in this order

1. `docs/SPEC.md` — product scope and behavior.
2. `docs/ARCHITECTURE.md` — implementation boundaries, data and failure handling.
3. `docs/BACKLOG.md` — ordered work with acceptance criteria.
4. `CLAUDE.md` — implementation workflow and constraints.
5. `docs/VALIDATION.md` — meaningful release checks and research evaluation.

## Starting with Claude Code

Copy this folder's contents into a new project repository. Start Claude Code from that root and request:

> Read CLAUDE.md and all documents listed in README.md. Implement TRB-010 only. Establish the project and test infrastructure without expanding scope. Report changed files, validation results, unresolved issues, and the next recommended task. Do not deploy, spend on live APIs, or commit unless I request it.

Continue with one backlog item or a small coherent group in dependency order. All items begin TODO. No credentials are included. Product name is a working label.

## Decision status

Confirmed: TypeScript, NestJS, grammY, PostgreSQL, Prisma, pg-boss, OpenAI Responses API with web search; Railway; invitations; private chats; daily/weekly/manual tasks; per-user time zone; history; independent delivery retries; quotas and shared provider credentials; Telegram administration.

Implementation defaults proposed by this package, adjustable without changing the product scope: Ukrainian UI and default output; manual-only drafts; daily/weekly schedules with one local time; invitation expiry of seven days; one active research request globally initially; bounded history and run settings below. These were not separately chosen by the owner.

Before the first paid production run the operator must select an available search-capable model, configure explicit budgets and an approved pricing snapshot, and supply secrets. Do not guess current model names, prices, SDK versions, or credentials.

## Local development

Prerequisites: Node.js 24 (`.nvmrc`), npm 11, Docker with Compose.

```sh
npm ci                      # installs pinned versions from package-lock.json; runs `prisma generate`
cp .env.example .env        # local placeholders only; never commit .env
npm run db:up               # dev PostgreSQL on 127.0.0.1:5434, disposable test PostgreSQL on 127.0.0.1:5433
npm run db:migrate:deploy   # apply Prisma migrations to the dev database
npm run build && npm start  # or: npm run start:dev
curl localhost:3000/health/live    # 200 while the process runs
curl localhost:3000/health/ready   # 200 when the database is reachable, otherwise 503
```

Invalid or missing required configuration stops startup with a list of the offending variable names (values are never printed). Only `DATABASE_URL` is always required. `TELEGRAM_MODE` and `RESEARCH_MODE` default to `disabled`; enabling either makes its variables required (see `.env.example`). `RESEARCH_MODE=live` additionally requires the OpenAI key, an explicitly selected model and finite bounds, and fails startup clearly when any is missing. USD budget variables are parsed but not enforced before TRB-050.

Database operations are bounded by `DATABASE_CONNECT_TIMEOUT_MS` (connection and pool acquisition, default 5000), `DATABASE_STATEMENT_TIMEOUT_MS` (server-side statement timeout, default 30000; a client-side read timeout 5 s longer is the backstop) and `DATABASE_SHUTDOWN_TIMEOUT_MS` (maximum wait for in-flight work on shutdown, default 5000). Readiness shares one in-flight database probe and answers within 2 s.

Checks:

| Command | Purpose |
|---|---|
| `npm run lint` / `npm run typecheck` / `npm run format:check` | Static checks |
| `npm test` | Unit tests; no database and no external network (stalled-database tests use a loopback TCP fixture), `DATABASE_URL` is removed from the test environment |
| `npm run test:integration` | Creates a uniquely named database on the `TEST_DATABASE_URL` server, applies migrations, runs tests, drops it. Refuses non-loopback hosts (unless `TEST_DATABASE_ALLOW_NON_LOCAL=true`), endpoint-overriding query parameters (`host`, `hostaddr`, `port`, `service`, `servicefile`) in either URL, and any server that may be the one used by `DATABASE_URL` (same port and same host or both loopback aliases) |
| `npm run build` | Compiles to `dist/` |
| `docker build -t telegram-research-bot .` | Production image; `node dist/main.js` as non-root user |

The dev database uses port 5434 so that it does not collide with a locally installed PostgreSQL on 5432. CI (`.github/workflows/ci.yml`) runs the same checks against a PostgreSQL service container, with no secrets and no paid external calls.

### Research prototype (TRB-020)

Administrator-only, private-chat commands: `/research <prompt>` (acknowledges with a run ID; the sourced report arrives separately) and `/result <run-id>` (resends the stored report, never researches again). Webhook at `POST /telegram/webhook` (secret header required) or development polling. Research and delivery run in database-backed in-process workers, one research request at a time. An unresolved UNCERTAIN live run (a billed request may still be active) blocks further live research until an operator reconciles it with `npm run ops:reconcile`. Before any live use, enable an OpenAI project hard spend limit with "Enforce a hard limit" turned on; spend alerts alone do not stop traffic, and application budgets are not enforced before TRB-050.

To try it without cost, use `RESEARCH_MODE=fake`: simulated, clearly labelled results from dated synthetic fixtures. Real Telegram delivery still needs a bot token and is an operator action. Behaviour, recovery policy, enforced and unenforced cost controls, deferred items and the authorized live-sample procedure are in [docs/RESEARCH_SLICE.md](docs/RESEARCH_SLICE.md).

Prisma owns the `public` schema and its migrations in `prisma/migrations`; pg-boss will own a separate `pgboss` schema (TRB-060). The generated Prisma client is written to `src/generated/prisma` (not committed).

## Reference documentation

Official references consulted during planning on 2026-10-18; recheck exact integration syntax against installed versions before implementation:

- OpenAI web search: https://developers.openai.com/api/docs/guides/tools-web-search
- Telegram Bot API: https://core.telegram.org/bots/api
- Railway cron: https://docs.railway.com/cron-jobs
- Railway services: https://docs.railway.com/services
- pg-boss: https://github.com/timgit/pg-boss
- grammY: https://grammy.dev/
- OpenAI pricing: https://developers.openai.com/api/docs/pricing

No assertion is made that the proposed integration or deployment has already been tested.

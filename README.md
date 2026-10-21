# Telegram Research Bot — implementation brief

Version: 1.0 · 2026-10-18 · Documentation package and implementation: TRB-010 to TRB-090 DONE (TRB-020: tool-call metering unresolved); TRB-100 (Railway readiness and operational runbook) ready for review; not deployed. Status per task: docs/BACKLOG.md.

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
| `docker build -t telegram-research-bot .` | Production image (pinned base digest): `node dist/main.js` as non-root user; `node dist/ops/migrate.js` is the deployment migration step (TRB-100) |

The dev database uses port 5434 so that it does not collide with a locally installed PostgreSQL on 5432. CI (`.github/workflows/ci.yml`) runs the same checks against a PostgreSQL service container, with no secrets and no paid external calls.

### Research prototype (TRB-020)

Private-chat commands for users with completed onboarding (TRB-030): `/research <prompt>` (acknowledges with a run ID; the sourced report arrives separately) and `/result <run-id>` (resends the stored report, never researches again). Webhook at `POST /telegram/webhook` (secret header required) or development polling. Research runs through a PostgreSQL-backed pg-boss queue (TRB-060) and delivery through a separate pg-boss queue (TRB-080), one research request at a time. An unresolved UNCERTAIN live run (a billed request may still be active) blocks further live research until an operator reconciles it with `npm run ops:reconcile`. Before any live use, enable an OpenAI project hard spend limit with "Enforce a hard limit" turned on; spend alerts alone do not stop traffic, and application budgets (TRB-050) are local estimates, not a provider ceiling.

To try it without cost, use `RESEARCH_MODE=fake`: simulated, clearly labelled results from dated synthetic fixtures. Real Telegram delivery still needs a bot token and is an operator action. Behaviour, recovery policy, enforced and unenforced cost controls, deferred items and the authorized live-sample procedure are in [docs/RESEARCH_SLICE.md](docs/RESEARCH_SLICE.md).

### Access (TRB-030)

Administrators come from `ADMIN_TELEGRAM_IDS`; everyone else needs a single-use invitation:
- **Invite.** `/admin invite` sends a link that expires after 7 days by default. It needs `INVITATION_TOKEN_SECRET`.
- **Onboard.** New users open the link and confirm a time zone (Europe/Kyiv is suggested). Administrators onboard with `/start` and confirm a time zone too.
- **Suspend.** `/admin suspend <Telegram ID>` and `/admin reactivate <Telegram ID>` manage access.
- **Live research** remains administrator-only.

Commands, token handling, suspension semantics and the migration of existing runs are in [docs/IDENTITY.md](docs/IDENTITY.md).

### Tasks (TRB-040)

- **Commands.** `/tasks`, `/new` and `/cancel` manage saved research tasks: name, prompt, a manual, daily or weekly schedule, and their own time zone.
- **Dialogs.** Guided steps with Back and Cancel, persisted drafts (24 h), revision-checked edits, pause, resume and confirmed soft delete.
- **Execution.** Saving or changing a task never starts research by itself. "Запустити зараз" on a task card runs it once (TRB-050). Daily and weekly tasks run at their local time (TRB-070), with at most one catch-up (≤ 24 h) after downtime: [docs/SCHEDULING.md](docs/SCHEDULING.md).

Details: [docs/TASKS.md](docs/TASKS.md).

### Admission, quotas and accounting (TRB-050)

- **One admission path.** `/research` and a task's "Запустити зараз" go through one transactional admission. It enforces the queue, per-user active runs, daily quotas (UTC) and, for live research, monthly budgets.
- **Reservations.** Each live run gets a conservative reservation from operator-supplied pricing. Settlement uses an append-only usage ledger and an outbox event.
- **Live requirements.** Live admission is refused unless budgets, prices and allowances are configured, and it stays administrator-only.
- **Checking usage.** `/usage` shows the user's own quotas and estimates.
- **Operator resolution.** `npm run ops:accounting` records confirmed amounts for unresolved costs.
- **Not an invoice.** Estimates are not OpenAI invoices, and reservations are not a provider spending ceiling.

Details: [docs/ACCOUNTING.md](docs/ACCOUNTING.md).

### Queue execution and recovery (TRB-060)

- **Queue.** Admission writes an outbox event; a dispatcher publishes it to pg-boss in the same database transaction that marks it dispatched. pg-boss is the only path to a provider submission.
- **Jobs inspect, never authorize.** A job only asks a worker to inspect a run. Leases with fencing tokens, submission states and reservations in the database decide what happens; duplicate or late jobs do nothing.
- **Recovery.** A saved response ID is resumed after a crash or restart; a submission without a saved ID becomes UNCERTAIN and is never resubmitted automatically.
- **Fairness.** One run at a time globally; the least recently served user goes first.
- **Retries.** A new provider submission is made only after an HTTP 429 refusal, when `RESEARCH_SUBMISSION_RETRY_LIMIT` allows it (default 0), with its own reservation.

Details, retry matrix, rollout and operator procedures: [docs/QUEUE.md](docs/QUEUE.md).

### Delivery and history (TRB-080)

- **Separate delivery queue.** Reports and messages are stored, with their delivery request, before anything is sent. A Telegram failure never triggers research, and resends cost no research quota.
- **Ambiguous sends.** A confirmed part is never resent. A send whose outcome is unknown becomes `UNKNOWN` and is not retried automatically; exactly-once delivery is not claimed.
- **Long reports.** A report longer than 6 messages arrives as a summary and a complete UTF-8 text file with the same numbered sources.
- **History.** `/history` (new), and "Історія" / "Останній результат" on task cards, show runs, delivery states and estimated usage. A run card can resend the stored result (`/result <id>` still works).
- **Blocked bot.** If Telegram confirms the bot was blocked, automatic research is paused (tasks paused, queued scheduled runs cancelled with their reservations released). Writing to the bot again restores the chat; tasks are resumed one by one.

Details, state transitions, retry classification, document format and rollout: [docs/DELIVERY.md](docs/DELIVERY.md).

### Administration and data lifecycle (TRB-090)

- **Administration.** `/admin users`, `/admin user <ID>`, `/admin limit <ID> <name> <value|default>`, `/admin usage`, `/admin invites`, `/admin revoke <ID>` and `/admin audit` extend `/admin invite|suspend|reactivate`. The views show metadata only, never prompts or reports.
- **Limits.** Per-user overrides of the task, run, active-run and budget limits fall back to the environment defaults. Global budget, concurrency, model and pricing stay operator-controlled.
- **Retention.** Cleanup is off by default (`RETENTION_CLEANUP=off`). When enabled, it removes prompts, reports, documents and message copies after `REPORT_RETENTION_DAYS` (30), and inbox and queue bookkeeping after `METADATA_RETENTION_DAYS` (90). Accounting evidence is kept.
- **Privacy.** `/privacy` tells users what is stored and for how long.

Details: [docs/ADMINISTRATION.md](docs/ADMINISTRATION.md) and [docs/RETENTION.md](docs/RETENTION.md).

### Deployment and operations (TRB-100)

Not deployed yet. [docs/OPERATIONS.md](docs/OPERATIONS.md) is the Railway runbook: deployment design, service settings, environment checklist, migrations, release classes and rollback, webhook registration and secret rotation, shutdown and recovery, diagnostics, backup and restore, incident procedures. Operator commands run from the production image (`node dist/ops/<name>.js`; locally `npm run ops:<name>` after `npm run build`):

| Command | Purpose |
|---|---|
| `migrate` | Deployment step: `prisma migrate deploy`, pg-boss schema, verification |
| `status` | Read-only diagnostics: schema, hold, queue age, stalled work, scheduler lag, UNCERTAIN runs, UNKNOWN and failed deliveries, pending blocks, accounting, retention. `--quiesced` checks that nothing executes |
| `hold` | Durable execution hold for restored or suspect databases |
| `webhook` | Explicit `getWebhookInfo` / `setWebhook` / `deleteWebhook`; never drops pending updates |
| `reconcile`, `accounting`, `tool-telemetry` | Existing operator commands (TRB-020, TRB-050) |

Prisma owns the `public` schema and its migrations in `prisma/migrations`; pg-boss owns a separate schema (`QUEUE_SCHEMA`, default `pgboss`), which the deployment step and the application install (TRB-060, TRB-100). The generated Prisma client is written to `src/generated/prisma` (not committed).

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

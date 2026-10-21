# TRB-100: deployment and operations runbook

How to deploy the bot to Railway, upgrade it, roll it back, back it up, restore it and handle incidents. Written for the owner acting as operator.

**Status.** Prepared and validated locally only: Docker image, disposable PostgreSQL databases, fake research provider, a local Bot API double. Nothing was deployed, no Railway resource was created or changed, no webhook was registered, no Telegram message was sent and OpenAI was not called. Evidence: docs/VALIDATION.md, "TRB-100 evidence".

## 1. Deployment design

- **One always-on service** (`bot`), built from the repository `Dockerfile`. It serves the webhook and runs the scheduler, both outbox dispatchers, the research and delivery workers and, if enabled, retention cleanup, in one Node.js process.
- **One PostgreSQL service** (Railway's PostgreSQL template). Prisma owns the `public` schema; pg-boss owns a separate schema (`QUEUE_SCHEMA`, default `pgboss`).
- **Ingress.** Telegram webhook over Railway's public HTTPS domain: `POST https://<domain>/telegram/webhook`, authenticated by the `X-Telegram-Bot-Api-Secret-Token` header (constant-time check).
- **Durable state is only in PostgreSQL.** The container writes nothing it needs later; no volume is attached to the service.
- **No sleeping.** The scheduler runs in the process, and a sleeping service would only wake on inbound traffic. Railway's Serverless (app sleeping) must stay off.
- **One replica.** Every rule is enforced in the database (leases, fencing, unique keys), so a second process is safe for the same version (tested), but the design starts with one.
- **Not used:** Redis, another queue, a frontend, Railway cron jobs.

### Processes and artifact

| Step | Artifact | Command |
|---|---|---|
| Build | `Dockerfile` (multi-stage; base `node:24.19.0-bookworm-slim@sha256:a9f5f7c9…`) | Railway builds it |
| Pre-deploy (migrations) | same image | `node dist/ops/migrate.js` |
| Start | same image, user `node` | `CMD ["node", "dist/main.js"]` (no start command override) |
| Operator commands | same image (`railway ssh` into the service, or `docker run` locally) | `node dist/ops/<command>.js` (section 9) |

The image contains the compiled application, production dependencies, the Prisma CLI and its schema engine for Debian/OpenSSL 3, `prisma/schema.prisma`, `prisma/migrations` and `prisma.config.ts`. No build argument or secret is used, so Railway variables never enter the image.

## 2. Railway: verified facts, assumptions, open questions

Checked in Railway's documentation on 2026-10-21.

**Verified (documentation):**
- **Pre-deploy command.** Runs between build and deploy in a separate container from the new image, inside the private network and with the service's variables; no volumes. A non-zero exit fails the deployment and is not retried. No time limit by default; an optional timeout of 1–3600 s. (docs.railway.com/guides/pre-deploy-command)
- **Health check.** Polled only during deployment, on the injected `PORT`, from host `healthcheck.railway.app`; any 2xx passes. Default timeout 300 s (`RAILWAY_HEALTHCHECK_TIMEOUT_SEC`). On failure the deployment is marked failed and the previous one stays active. It is not used for ongoing monitoring. (docs.railway.com/reference/healthchecks)
- **Shutdown.** The old deployment gets SIGTERM once the new one is active and SIGKILL after the draining time. `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` defaults to **0**; no other signal is ever sent. `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` (default 0) keeps the old deployment active for that long after the new one becomes active. (docs.railway.com/deployments/deployment-teardown, /deployments/reference, /variables/reference)
- **Restart policy.** On Failure (default, 10 restarts), Always, Never. Free/trial plans: no Always, at most 10 restarts. (docs.railway.com/deployments/restart-policy)
- **Networking.** `PORT` is injected; the app must listen on `0.0.0.0:$PORT` (it does). Generated `*.up.railway.app` domains have managed TLS. Inbound traffic is TLS; a POST to port 80 is redirected as GET, so the webhook must use https. HTTP/1.1 idle connections close after 60 s; requests are closed after 5 min without data. (docs.railway.com/networking/…)
- **Variables.** Reference syntax `${{Postgres.DATABASE_URL}}`. Railway system variables are also provided to builds. (docs.railway.com/variables/reference)
- **PostgreSQL.** `DATABASE_URL` is the private connection; `DATABASE_PUBLIC_URL` exists only when public access (TCP proxy, billed egress) is enabled. Private DNS is `<service>.railway.internal`. (docs.railway.com/databases/postgresql, /networking/private-networking)
- **Backups.** Volume backups: manual, or scheduled daily (kept 6 days), weekly (27 days), monthly (89 days). A restore creates a new volume in the same project and environment, mounted in place of the old one, which is kept unmounted; it is staged and applied with Deploy. Manual backups are limited to 50% of the volume size; wiping a volume deletes its backups. (docs.railway.com/volumes/backups)
- **Point-in-time recovery** for PostgreSQL: restores into a new sibling service; the window starts with the first base backup after enabling and covers about 4 weeks. (docs.railway.com/volumes/point-in-time-recovery)
- **Rollback** redeploys an earlier deployment's image and custom variables, within the plan's image retention (Hobby 72 h, Pro 120 h). (docs.railway.com/guides/roll-back-bad-deploy)
- **Operator access.** `railway ssh -- <command>` runs a command in the deployed container. `railway run` runs locally with the service's variables. (docs.railway.com/cli/ssh, /cli/run)
- **Config as code** (`railway.json`/`railway.toml`) is **deprecated**: existing files work for legacy services until 2026-12-01. Its replacement, Infrastructure as Code (`.railway/railway.ts` with `railway config apply`), creates and modifies resources. **Therefore this repository adds no Railway file;** the owner applies the settings below in the service settings.

**Assumptions (not stated in the documentation; verify when deploying):**
- Railway builds the root `Dockerfile` automatically and uses its `CMD`.
- The pre-deploy command runs while the previous deployment is still active. The procedures below are written so that this does not matter.
- `railway ssh` sessions get the service's variables and start in the image's working directory `/app` (otherwise `cd /app` first).
- Restarting a deployment sends SIGTERM and honours the draining time.
- The template's internal `DATABASE_URL` needs no `sslmode` (private network).

**Plan- or account-dependent:** volume backups and their schedules, PITR, restart policy limits, rollback image retention, the maximum draining and overlap values.

**Open questions:** PostgreSQL major version of the template (`SHOW server_version;` decides the `pg_dump` client version), whether backups can be downloaded, the maximum `drainingSeconds`, whether a rollback re-runs the pre-deploy command (it is harmless: `migrate deploy` with an older migration set reports "No pending migrations", tested).

## 3. Service settings

| Setting | Value | Why |
|---|---|---|
| Source | the GitHub repository, branch chosen by the owner | — |
| Builder | Dockerfile (`/Dockerfile`) | the tested artifact |
| Start command | empty (image `CMD`) | exec form: node is PID 1 and receives SIGTERM |
| Pre-deploy command | `node dist/ops/migrate.js` | section 5 |
| Pre-deploy timeout | 600 s | migrations are small; a hang must fail the deployment |
| Health check path | `/health/ready` | 200 only when database, queue, schema and required workers are up (or deliberately held) |
| Health check timeout | 300 s (default) | startup takes seconds |
| Restart policy | On Failure, 10 | a crash restarts; exit 0 after SIGTERM does not |
| Draining seconds (`RAILWAY_DEPLOYMENT_DRAINING_SECONDS`) | **60** | default 0 would SIGKILL at once; must exceed `SHUTDOWN_TIMEOUT_SECONDS` (55) |
| Overlap seconds | 0 | keep two versions together as briefly as possible |
| Replicas | 1 | section 1 |
| Serverless / app sleeping | off | the scheduler must run without inbound traffic |
| Networking | generate a public domain, target port = `PORT` | webhook URL |
| Volumes | none | no local durable state |

## 4. Environment variables

Placeholders only. Secrets go into Railway variables (sealed where offered), never into the repository or the image.

| Variable | Required | Secret | Initial value | Notes |
|---|---|---|---|---|
| `NODE_ENV` | yes | no | `production` | JSON logs; https and webhook-only checks |
| `DATABASE_URL` | yes | yes | `${{Postgres.DATABASE_URL}}` | private connection |
| `PORT` | injected | no | — | do not set |
| `TELEGRAM_MODE` | yes | no | `disabled` for the first start, then `webhook` | polling is refused in production |
| `TELEGRAM_BOT_TOKEN` | with Telegram | yes | `<bot token>` | never logged |
| `TELEGRAM_WEBHOOK_SECRET` | with webhook | yes | `<random 32–64 chars of A-Z a-z 0-9 _ ->` | e.g. `openssl rand -hex 32` |
| `TELEGRAM_WEBHOOK_SECRET_PREVIOUS` | only during rotation | yes | empty | section 7 |
| `PUBLIC_BASE_URL` | with webhook | no | `https://<service>.up.railway.app` | no trailing path |
| `ADMIN_TELEGRAM_IDS` | with Telegram | no | `<owner's numeric Telegram ID>` | administrators |
| `TELEGRAM_BOT_USERNAME` | optional | no | `<bot username>` | invitation links |
| `INVITATION_TOKEN_SECRET` | for invitations | yes | `<random ≥ 32 chars>` | rotating it voids unsent invitations |
| `RESEARCH_MODE` | yes | no | `disabled`, later `fake` for a smoke test, `live` only by owner decision | |
| `BACKGROUND_WORKERS` | yes | no | `on` | |
| `RETENTION_CLEANUP` | yes | no | `off` | enabling it is a separate owner decision (docs/RETENTION.md) |
| `QUEUE_SCHEMA` | no | no | `pgboss` | never `public` |
| `SHUTDOWN_TIMEOUT_SECONDS` | no | no | `55` | below draining seconds |
| `LOG_LEVEL` | no | no | `log` | |

**Live research** (`RESEARCH_MODE=live`) additionally needs, before the first admission, values the owner chooses: `OPENAI_API_KEY` (secret), `OPENAI_MODEL`, `OUTPUT_TOKEN_LIMIT`, `TOOL_CALL_LIMIT`, `RUN_DEADLINE_SECONDS` (≤ 540), `USER_MONTHLY_BUDGET_USD`, `GLOBAL_MONTHLY_BUDGET_USD`, `RUN_MAX_ESTIMATED_COST_USD`, `PRICING_VERSION`, `PRICING_MODEL`, `PRICING_RETURNED_MODELS`, the four `OPENAI_PRICE_*` rates and `RESERVATION_INPUT_TOKENS`, `RESERVATION_WEB_SEARCH_CALLS`. Missing values refuse live admission (fail closed). Also set an OpenAI project hard spend limit with "Enforce a hard limit" on.

**Keep as accepted:** `RESEARCH_SUBMISSION_RETRY_LIMIT=0`, `RESEARCH_QUEUE_MAX_WAIT_SECONDS=3600`, `RESEARCH_CAPACITY_RETRY_SECONDS=15`. Live research stays administrator-only. Scheduler and quota defaults are documented in `.env.example`.

**Never set in production:** `FAKE_PROVIDER_LATENCY_MS` (fake-mode rehearsal only), `TELEGRAM_API_ROOT` (local Bot API double).

## 5. Migrations

**`node dist/ops/migrate.js`** (the pre-deploy command) does, in order:
1. Validates the complete configuration: an invalid variable fails the deployment before the schema changes.
2. Runs `prisma migrate deploy` from the image (Prisma 7.10.0, `prisma.config.ts`, `prisma/migrations`). Only this command: never `migrate dev`, `db push`, `migrate reset` or checksum edits.
3. Installs or upgrades the pg-boss schema (`QUEUE_SCHEMA`) with pg-boss 12.37.0 (schema version 45), without workers or maintenance. pg-boss migrates inside a transaction under its own advisory lock, so concurrent starts are safe.
4. Verifies that every migration shipped in the image is applied and none failed. It prints one JSON line; Prisma prints the database host and name, never the password.

Any failure exits non-zero, and Railway then does not start the new deployment.

**The application never runs Prisma migrations.** At startup it compares the database with the migrations in its image (the execution gate). While one is missing or failed, it serves health checks only: no worker, scheduler, dispatcher or retention starts, the webhook answers 503 (Telegram retries later), and `/health/ready` is 503 with `checks.schema = "down"`. A database with migrations unknown to the image (an older image after an additive migration) is allowed and logged. The application still runs pg-boss's own install and migration at startup (`migrate: true`, unchanged since TRB-060), which is idempotent and locked.

**pg-boss permissions.** The database user needs `CREATE` on the database (schema creation) and owns the `pgboss` schema. Railway's template user owns its database, so nothing else is needed. pg-boss state is transport only (job IDs); every decision is in the application tables.

**Failed migration.**
1. The deployment stopped; the previous deployment keeps running. If the failed migration is not compatible with it, see section 6.3.
2. Read the error in the pre-deploy log (Prisma `P3018` names the migration and the SQL error).
3. Fix the cause without editing applied migrations. Check whether the failed migration changed anything: PostgreSQL runs a migration script as one implicit transaction unless the script has its own transaction control, so a failed script normally leaves no change, but verify the objects it creates. If nothing changed, mark it rolled back: `cd /app && node node_modules/prisma/build/index.js migrate resolve --rolled-back <migration>` (from the image; tested). If it changed something, repair or restore deliberately first; never mark it applied without its effects.
4. Deploy again. The gate opens within 30 s of a successful migration (tested).

## 6. Releases, rollout and rollback

### 6.1 Compatibility classes

Each release states its class in the change notes.

| Class | Meaning | Procedure |
|---|---|---|
| **A. Same version** | restart, redeploy, two instances of one version | normal; overlap is safe (tested with two instances) |
| **B. Compatible** | additive migration only (new tables or nullable columns, new constraints the old code already satisfies) and the old code keeps working against the new schema while both run | normal deploy (6.2); rollback by redeploying the previous image (6.4) |
| **C. Incompatible behaviour** | old and new code must not process the same records concurrently, e.g. a changed state machine, queue contract or lease rule | stop → migrate → start (6.3) |
| **D. Destructive or irreversible** | dropping or rewriting data or columns the old code reads | stop → migrate → start, backup immediately before; restoring an older image afterwards is **unsafe** (6.4) |

**This release (TRB-100) is class B relative to TRB-090:** one additive migration (`operational_hold`, an empty table), no change to research, delivery, accounting or retention semantics. An older image ignores the hold table (and with it the restore protection).

**Legacy restriction (unchanged).** A database that ever ran a version older than TRB-080 must be upgraded with 6.3: the TRB-060 and TRB-080 mechanisms must not overlap with their predecessors (docs/QUEUE.md and docs/DELIVERY.md, "Rollout"). A new Railway database is not affected.

A healthy HTTP check of the new deployment does not mean the old process stopped: Railway stops the old deployment only after the new one is active, and the old process may still be draining for up to the draining time. Use `node dist/ops/status.js --quiesced` to check that nothing is executing.

### 6.2 Initial deployment

1. **PostgreSQL.** Create the PostgreSQL service in the project. Note its version: `SHOW server_version;`.
2. **Service.** Create the `bot` service from the repository and apply section 3. Do not generate the webhook yet.
3. **Safe first variables** (section 4): `NODE_ENV=production`, `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `TELEGRAM_MODE=disabled`, `RESEARCH_MODE=disabled`, `BACKGROUND_WORKERS=on`, `RETENTION_CLEANUP=off`.
4. **Deploy.** Pre-deploy migrates the empty database; `/health/ready` must answer 200 with `schema: up`, `queue: disabled`, `workers: disabled` or `up`.
5. **Check.** `railway ssh -- node dist/ops/status.js` shows no warnings, 15 applied migrations and pg-boss schema version 45 once a queue exists.
6. **Public domain.** Generate it; set `PUBLIC_BASE_URL=https://<domain>`.
7. **Telegram.** Add `TELEGRAM_MODE=webhook`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ADMIN_TELEGRAM_IDS`, `INVITATION_TOKEN_SECRET`; deploy. Readiness shows `queue: up` (delivery queue).
8. **Webhook.** Make sure no other process polls this bot token. Run `railway ssh -- node dist/ops/webhook.js --info`, then `--set` (dry run), then `--set --confirm`, then `--info` again: `urlMatches` and `allowedUpdatesMatch` must be true and `lastErrorMessage` empty after the first update.
9. **Smoke test.** From the owner's account: `/start`, confirm the time zone, `/help`. Optionally `RESEARCH_MODE=fake` for one simulated run (no cost).
10. **Live research** only after the owner sets budgets, pricing and the OpenAI hard limit (section 4) and switches `RESEARCH_MODE=live`.

### 6.3 Stop → migrate → start (classes C and D, legacy databases)

The hold (section 8.3) is used as a maintenance switch: every process on the database starts held, and a held process opens by itself within 30 s of the hold being cleared.
1. **Stop ingress, keep updates.** `node dist/ops/webhook.js --delete --confirm`. Telegram keeps undelivered updates for up to 24 h; the window must stay well below that.
2. **Hold.** `node dist/ops/hold.js --set --reason "<release>" --operator <name>`.
3. **Restart the running deployment** (Railway "Restart" or redeploy of the same image). It drains on SIGTERM and comes back held.
4. **Quiesced?** `node dist/ops/status.js --quiesced` must exit 0: no live research lease, no delivery being sent, no active queue job. A run interrupted at this point is recovered later under the usual rules (section 10).
5. **Backup** for class D (section 11).
6. **Deploy the new version.** Pre-deploy migrates while nothing executes; the new deployment starts held (`/health/ready` 200, `status: held`), becomes active, and the old one is stopped.
7. **Check** `node dist/ops/status.js`: no `SCHEMA_NOT_AT_THIS_BUILD`, expected migrations.
8. **Open.** `node dist/ops/hold.js --clear --operator <name> --confirm`; readiness turns `ok` within 30 s.
9. **Ingress.** `node dist/ops/webhook.js --set --confirm`; Telegram delivers the pending updates.

### 6.4 Rollback

- **Never use down-migrations as a generic rollback.** Fix forward, or restore (section 11).
- **Class A/B:** use Railway's rollback (previous image and variables) or redeploy the previous commit. The newer migrations stay applied; the older image accepts them (logged as "database has migrations unknown to this build"). If the rollback re-runs the older pre-deploy command, it finds nothing pending (tested).
- **Class C:** roll back with 6.3 (hold, restart, deploy the older image, clear).
- **Class D:** an older image must not run on the changed schema. Restore the pre-migration backup into a new database (section 11) and point the older image at it, accepting the loss of everything after the backup.
- **Failed build:** nothing changes; the previous deployment stays active.
- **Failed start or health check:** the previous deployment stays active; read the logs. Migrations that already ran are class A/B by definition of a release, so the previous image keeps working.

## 7. Webhook and Telegram modes

`node dist/ops/webhook.js` is the only code that changes Telegram's webhook. Nothing calls it on install, build or start, and the application never deletes a webhook or starts polling by itself. It always sends `drop_pending_updates=false` and has no option to drop updates. It prints the URL and Telegram's error description, never the token or the secret.

| Task | Command |
|---|---|
| Inspect | `--info`: URL, expected URL, `allowed_updates`, pending count, last error |
| Register | `--set` (dry run), then `--set --confirm`: URL `PUBLIC_BASE_URL/telegram/webhook`, `secret_token=TELEGRAM_WEBHOOK_SECRET`, `allowed_updates=["message","callback_query"]`. Refused unless `TELEGRAM_MODE=webhook` |
| Disable ingress | `--delete --confirm`: Telegram stops pushing and keeps updates for up to 24 h. Alternatively set `TELEGRAM_MODE=disabled` (the endpoint answers 404 and Telegram retries a limited number of times) |

**Polling → webhook** (development to production for one bot token). Polling is development-only and refused in production.
1. Stop every polling process for this token (it stops by itself on a 409 once a webhook exists, but must not run).
2. Deploy with `TELEGRAM_MODE=webhook`.
3. `--set --confirm`. Updates waiting since polling stopped are delivered to the webhook.

**Webhook → polling** (for local debugging only, never with the production token while the service runs): `--delete --confirm` from the production service, then start polling locally.

**Secret rotation** without failed deliveries:
1. Set `TELEGRAM_WEBHOOK_SECRET_PREVIOUS=<current secret>` and `TELEGRAM_WEBHOOK_SECRET=<new secret>`; deploy. Both are accepted (constant-time, tested).
2. `--set --confirm` registers the new secret.
3. After one successful update with the new secret (or a few minutes), remove `TELEGRAM_WEBHOOK_SECRET_PREVIOUS`; deploy.

**Leaked bot token:** revoke it with @BotFather, set the new token, deploy, run `--set --confirm` (the webhook belongs to the token).

## 8. Shutdown, restart and recovery

### 8.1 Shutdown order (SIGTERM or SIGINT)

1. Every component stops taking new work at once: scheduler, dispatchers and retention take no further pass, polling aborts, both pg-boss workers stop fetching, and readiness turns 503.
2. Work in progress is finished or handed over, bounded: a provider call in flight is awaited (≤ `OPENAI_HTTP_TIMEOUT_MS` + 5 s = 35 s) so that its response ID is saved, and a polling run releases its lease with a wake-up. A Telegram send in flight is awaited (≤ 20 s; Telegram HTTP timeout 15 s) and the delivery stops before its next part. Loops get ≤ 10 s.
3. pg-boss stops (≤ 5 s), the HTTP server closes after in-flight requests, and the database pool drains last (≤ `DATABASE_SHUTDOWN_TIMEOUT_MS`, 5 s).
4. The process exits 0, or 1 at the latest after `SHUTDOWN_TIMEOUT_SECONDS` (55 s).

Steps 1 and 2 run for all components together, so the expected worst case is about 45 s; measured: 0.6–0.9 s idle, 7.2 s during an 8 s provider submission, 8.05 s during an 8 s Telegram send (docker stop, local). Railway's draining time must therefore be set to 60 s (its default is 0).

### 8.2 If the process is killed anyway

The guarantees hold even without a graceful shutdown (SIGKILL, crash, platform failure, draining time too short); they only take longer, until the 60 s lease expires and the recovery sweep runs:

| In flight when killed | After restart |
|---|---|
| Provider submission without a saved response ID | Run `UNCERTAIN / SUBMISSION_INTERRUPTED`, reservation kept, never resubmitted (tested by SIGKILL) |
| Provider response ID saved | Polling resumes the same response within the original deadline (tested) |
| Telegram part handed to Telegram | Part and delivery `UNKNOWN`, never resent automatically (tested by SIGKILL) |
| Confirmed parts | Never resent (tested) |
| Recorded destination refusal not yet applied | Applied by the recovery sweep (TRB-080) |
| Reservations | Unchanged; settled, released or kept unresolved by the same rules |

Stale workers cannot finalize: every write after a claim is fenced. Two instances of the same version never submitted a run twice or resent a part (tested, in-process and with two containers). No claim is made for overlapping different versions beyond class B.

### 8.3 Operational hold

`node dist/ops/hold.js --status | --set --reason <text> --operator <name> | --clear --operator <name> --confirm`. A durable row in the database (`operational_hold`). While it exists, a process **starting** on that database runs nothing that acts: no webhook processing (503, so Telegram keeps the updates), scheduler, dispatcher, worker, polling or retention. Readiness answers 200 with `status: "held"`, so the deployment stays observable. Operator commands still work. A process that is already running notices a new hold only after a restart; clearing the hold opens held processes within 30 s.

### 8.4 Process restart versus database recovery

- **Restart, redeploy, crash:** the database is current, so everything above applies and nothing external is repeated.
- **Restoring a backup or a point in time:** the database goes back in time, but OpenAI requests and Telegram messages made after that point happened anyway. Section 11 applies; never treat a restored database like a restart.

## 9. Health and diagnostics

| Probe | Meaning |
|---|---|
| `GET /health/live` | Process up; no dependency. HTTP comes up within about 10 s even when the database is unreachable (startup waits are bounded) |
| `GET /health/ready` | 200 `ok`: database answers, queue started (if configured), schema at this build, every required worker or loop running and not stalled. 200 `held`: same, deliberately held. Otherwise 503 `error`. Checks: `config`, `database`, `queue`, `schema`, `workers`, `execution`. Never calls OpenAI or Telegram; no error details or component names in the response |

**Three different things:**
- **Railway's health check** only gates a deployment.
- **Ongoing monitoring** needs an external check of `/health/ready` (e.g. an uptime monitor; not part of this repository) and a periodic `ops:status`.
- **Application readiness** also turns 503 during shutdown and while a required component failed or a loop stopped finishing passes.

**`node dist/ops/status.js`** prints JSON: counts, ages and identifiers only, never prompts, reports or secrets. It never changes anything.

| Section | Shows | Warning |
|---|---|---|
| `schema` | pending, failed, unknown migrations | `SCHEMA_NOT_AT_THIS_BUILD`, `DATABASE_NEWER_THAN_BUILD` |
| `hold` | reason, operator, since | `OPERATIONAL_HOLD_SET` |
| `queue` | pg-boss schema version, open jobs and oldest age per queue | — |
| `research` | runs by state, oldest queued age, running runs with lease state, unreconciled UNCERTAIN runs, outbox due/deferred and oldest due age | `UNCERTAIN_RUNS_UNRECONCILED`, `RESEARCH_LEASE_EXPIRED`, `RESEARCH_OUTBOX_LAG` (> 120 s) |
| `scheduler` | overdue active tasks, maximum lag, uninitialized tasks, last schedule event | `SCHEDULER_LAG` |
| `delivery` | states (total and last 7 days), deliveries being sent, recorded refusals not applied, outbox | `DELIVERY_UNKNOWN_RECENT`, `DELIVERY_LEASE_EXPIRED`, `DESTINATION_BLOCK_PENDING`, `DELIVERY_OUTBOX_LAG` |
| `accounting` | reservations by status and exposure, current UTC month exposure, settled runs with uncertain searches, denials in the last 24 h by reason | `ACCOUNTING_UNRESOLVED` |
| `retention` | settings, runs past retention, purged runs, inbox tombstones | — |

`--quiesced` exits 0 only when no research lease is live, no delivery is being sent and no queue job is active.

**Logs** (JSON, no content or secrets) worth alerting on: `Research submission failed`, `Accepted response not recorded`, `Took over expired research run`, `Database schema is not at this build`, `Operational hold is set`, `Readiness: components not up`, `Polling conflicts with a webhook`, `Queue start failed`, `Shutdown exceeded SHUTDOWN_TIMEOUT_SECONDS`.

## 10. Incident procedures

Never do any of these: reset an ambiguous run or delivery to `QUEUED`/`PENDING`; release or settle an unknown cost as zero; delete inbox tombstones or other records to make something retry; clear a suppression marker or a recorded refusal to deliver old reports; edit applied migrations or `_prisma_migrations` checksums.

Commands below run in the service (`railway ssh -- node dist/ops/…`).

| Incident | Evidence the operator needs | Action | New cost or duplicates? |
|---|---|---|---|
| **UNCERTAIN provider submission** (live run blocks further live research) | `reconcile-run.js --list`: run ID, submission time, response ID if any; OpenAI dashboard logs and usage for that time | Reconcile with the matching resolution (docs/QUEUE.md, "Operator handling"), then resolve its cost: `accounting.js --run <id> --confirmed-usd <amount> --operator <name> --note <evidence>` | Reconciliation costs nothing. A new run is a new paid request |
| **Provider response no longer retrievable** (`RESPONSE_NOT_RETRIEVABLE`, deadline cancel unconfirmed) | OpenAI usage for the response ID | Same as above | Same |
| **Telegram delivery UNKNOWN** | `status.js` (delivery section), the user's report of what arrived | Nothing automatic. The user (or owner on their behalf) uses the run card's resend / `/result <id>` | A resend may duplicate a message; it costs no research |
| **Blocked chat** | delivery `PERMANENT_FAILURE / TELEGRAM_403`, user's `chat_blocked_at` | None; tasks were paused. The user writes to the bot again and resumes tasks one by one | No |
| **Exhausted budget** | `status.js` (accounting: exposure, denials) and `/admin usage` | Wait for the next UTC month, or raise a limit deliberately (`/admin limit` or the budget variables); resolve UNRESOLVED reservations with billing evidence | Raising a budget allows new paid runs |
| **Accounting correction** | OpenAI billing for the run | `accounting.js --correct --run <id> --confirmed-usd <amount> --operator <name> --note <evidence>` (appends a CORRECT entry) | No |
| **Database or queue outage** | readiness `database: down` or `queue: down`; Railway PostgreSQL status | Restore the database service; the app reconnects and the queue restarts by itself (tested). Afterwards run `status.js`: expired leases are taken over after 60 s; check UNCERTAIN and UNKNOWN entries as above | Not by itself |
| **Failed migration** | pre-deploy log | Section 5, "Failed migration" | No |
| **Corrupted or missing backup** | `pg_restore --list` fails, or no recent file | Take a new logical backup now; do not delete existing Railway backups; check the schedule and storage; if the database itself is damaged, use a Railway volume backup or PITR into a new service and follow section 11 | No |
| **Accidental live-mode activation** | `Bootstrap` log "LIVE research enabled", `status.js` | Set `RESEARCH_MODE=disabled` and deploy at once: nothing is submitted any more; queued live runs wait and are cancelled by the recovery sweep after the maximum wait (3600 s), releasing their reservations. Reconcile and resolve any run that was submitted. To stop everything at once: hold, then restart | Runs already submitted are billed |

## 11. Backup and restore

### 11.1 What a backup must contain

The whole database: application tables (runs, attempts, reservations, ledger, reconciliations, audit, inbox tombstones, deliveries with immutable payloads and confirmed Telegram message IDs, recorded refusals, tasks and schedules, outbox events) **and** the pg-boss schema, all from one snapshot. pg-boss state could be rebuilt (the recovery sweeps re-wake runs and deliveries whose jobs are missing), but restoring it from the same snapshot is simpler and was tested.

### 11.2 Taking a backup

**Railway volume backups** of the PostgreSQL service (plan-dependent, section 2): enable a daily schedule. They restore only into the same project and environment.

**Logical backups** (portable, also before risky releases), with the PostgreSQL client of the server's major version (17: `postgres:17.11-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24`, verified 2026-10-21):
1. Temporarily enable public access on the PostgreSQL service (TCP proxy), or run the client inside the project.
2. Put the connection into an env file readable only by you (never on the command line):
   ```sh
   # backup.env (chmod 600)
   PGHOST=<proxy host>
   PGPORT=<proxy port>
   PGUSER=<user>
   PGPASSWORD=<password>
   PGDATABASE=<database>
   PGSSLMODE=require
   ```
3. Dump (custom format, both schemas):
   ```sh
   docker run --rm --env-file backup.env -v "$PWD/backups:/backups" \
     postgres:17.11-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24 \
     sh -c 'pg_dump --format=custom --no-owner --no-privileges --file=/backups/trb-$(date -u +%Y%m%dT%H%M%SZ).dump'
   ```
4. Check it: `pg_restore --list <file>` lists `TABLE DATA` for `public` and `pgboss`.
5. Disable public access again.

**Backups are copies of user content** (prompts, reports, message payloads still inside the retention period) and of accounting and audit metadata. Application retention never deletes them: an old backup keeps content the application has since purged. Store them encrypted, with access limited to the owner, and delete them on a schedule the owner decides (e.g. 7 daily copies); Railway deletes its scheduled backups after the periods in section 2.

### 11.3 Restoring (always into a new database)

Never restore over the production or development database.
1. **New target.** A new PostgreSQL service (or Railway's PITR/volume restore, which creates new storage), or a new empty database on a server. Do not point any application at it yet.
2. **Restore:**
   ```sh
   docker run --rm --env-file restore.env -v "$PWD/backups:/backups" \
     postgres:17.11-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24 \
     pg_restore --no-owner --no-privileges --exit-on-error --single-transaction \
       --dbname="<new database>" /backups/<file>.dump
   ```
3. **Hold immediately, before any application connects:** `node dist/ops/hold.js --set --reason "restored <file>" --operator <name>` with `DATABASE_URL` of the new database (e.g. `docker run --rm -e DATABASE_URL=… <image> node dist/ops/hold.js …`, or `railway ssh` after pointing a held service at it).
4. **Keep external effects off** for the first start on the restored copy: `TELEGRAM_MODE=webhook` is harmless while held (503), but do not register the webhook to it yet; keep `RESEARCH_MODE` as it was or `disabled`.
5. **Verify** (`status.js` and SQL):
   - **schema:** no pending or failed migrations, pg-boss version 45;
   - **accounting:** reservation exposure per status and ledger sums match the source at backup time (or the last known report);
   - **deduplication:** `telegram_update` count and tombstones present;
   - **deliveries:** confirmed Telegram message IDs present, `UNKNOWN` deliveries still `UNKNOWN`, purged parts still purged;
   - **work:** task schedules (`next_run_at`), queued and running runs, pending deliveries, recorded refusals;
   - **holds:** `OPERATIONAL_HOLD_SET` is the only expected new warning.
6. **Reconcile before reopening** (the backup is older than reality):
   - **OpenAI:** every request after the backup time is unknown to the restored database. Compare the OpenAI dashboard (requests and usage since the backup) with the restored runs. Runs that are `QUEUED` or `RUNNING` in the copy may already have been executed and billed: if so, cancel them deliberately (e.g. delete the task or suspend temporarily) rather than letting them run again; record known costs with `accounting.js`.
   - **Telegram:** messages sent after the backup time are unknown; pending deliveries in the copy may already have arrived. Decide whether to let them go out (possible duplicates) or to suppress them (suspend and reactivate the user, which never re-sends a backlog).
   - **Inbox:** updates processed after the backup time are not in the copy, so a redelivery of one of them would be processed again. Telegram does not redeliver acknowledged updates; updates still pending at Telegram are delivered once the webhook is set again.
   - **Configuration:** confirm budgets, pricing and modes.
7. **Open:** point the service's `DATABASE_URL` at the new database (deploy; it starts held), then `hold.js --clear --operator <name> --confirm`, then `webhook.js --set --confirm`.

**Limitation.** PostgreSQL cannot undo external effects. After restoring an older backup the application may forget submissions, sends, accounting changes and deduplication evidence created after the backup. The hold and the checklist reduce the risk; they cannot guarantee that no request is repeated or no message duplicated.

## 12. Owner actions before deployment

1. Review and accept TRB-100 (this runbook and the evidence).
2. Choose the Railway plan (backups, restart policy, rollback retention) and create the project, PostgreSQL and the service with section 3; verify the assumptions in section 2.
3. Create the secrets: bot token, webhook secret, invitation secret; later the OpenAI key.
4. Decide the backup policy: Railway schedule, logical dumps, storage, access and deletion.
5. Before live research: model, budgets, pricing snapshot, reservation allowances, OpenAI hard limit (TRB-110 prerequisites).
6. Decide retention (`RETENTION_CLEANUP`) and the SPEC §7 change proposed in docs/RETENTION.md.
7. Set up an external uptime check of `/health/ready` if wanted.

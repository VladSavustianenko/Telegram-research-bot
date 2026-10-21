# TRB-090: Telegram administration and effective limits

Administrator workflow in the private chat, built on the TRB-030 commands and services: invitations, suspension and reactivation, user listing, per-user limits, aggregate usage and failures, and the audit log. Financial resolution stays in the operator CLI (docs/ACCOUNTING.md).

## Commands

All are `/admin` subcommands; `/admin invite`, `suspend` and `reactivate` are unchanged.

| Command | What it does |
|---|---|
| `/admin` | Administrator help |
| `/admin invite` | Single-use invitation (unchanged) |
| `/admin invites` | Counts (valid, redeemed, expired, revoked) and the 8 latest invitations: ID, creator, times, status |
| `/admin revoke <invitation ID>` | Revokes a valid, unredeemed invitation; its undelivered link is suppressed (`INVITATION_REVOKED`), an already delivered link stops working |
| `/admin suspend <Telegram ID>` / `/admin reactivate <Telegram ID>` | Unchanged (docs/IDENTITY.md) |
| `/admin users [page]` | 8 users per page, stable order (creation time, then ID). A button per user opens the user view |
| `/admin user <Telegram ID>` | One user: identifiers, role, access state, onboarding, chat availability, key times, task counts, today's and this month's run counts, failures, this month's accounting, effective limits. Buttons: Suspend or Reactivate (not for administrators), back to the list |
| `/admin limit <Telegram ID> <name> <value\|default> [reason]` | Sets or clears one override (see below) |
| `/admin usage` | The current UTC period. Global totals and budget, the 5 largest users by exposure, run counts by state, the most frequent failure codes, delivery states, open cases |
| `/admin audit [page]` | 10 audit events per page, newest first |

**Buttons** (callback data ≤ 64 bytes, UUIDs in base64url):
- `au:<page>`: user list page;
- `av:<user>`: user view;
- `ax:<user>:<revision>:<s|r>`: suspend or reactivate.

The access button is bound to the user's revision. Any change (suspension, reactivation, limit change) makes an older button only show the current view with "Дані змінилися". Malformed or unknown IDs are ignored like a stale button.

## Authorization

- **Identity.** The administrator is the authenticated Telegram sender. `ADMIN_TELEGRAM_IDS` stays authoritative (`isAdministrator` requires the configuration and the synchronized role).
- **Checked in the service.** `runAdminCommand` and `runAdminCallback` call `adminOperationDenial` themselves, not only the router. A member, a removed administrator or a suspended administrator gets the unknown-command reply (commands) or the stale-button answer (buttons), so nothing is disclosed.
- **Private chats only.** Group, supergroup and channel updates are ignored before routing (TRB-030).
- **Protected targets.** Administrators (by role or configuration) cannot be suspended; the view shows no button for them.
- **Idempotent.** A duplicate Telegram update is a no-op (inbox deduplication by `update_id`). Repeating a limit with its current value changes nothing and writes no audit event. Suspending a suspended user is `NO_CHANGE`.
- **Lock order.** Mutations run in the inbox transaction (the administrator's identity lock and row), then take the target's row lock, as suspension always has.

## Privacy of the views

The views read only operational metadata:
- internal and Telegram IDs;
- role, access and onboarding state, chat availability;
- counts of tasks and runs;
- configured and effective limits;
- accounting totals (application estimates);
- run states and failure codes, delivery states;
- invitation IDs and times;
- audit kinds and details (identifiers, codes, counts, limit values and the administrator's reason).

They never read or show prompts, task names or prompts, report text, documents, citations, retrieved sources, invitation tokens or token hashes. An integration test plants a marker in all of these and checks every view. Text is escaped on delivery, and each view is bounded (8 users, 5 top users, 5 codes, 8 invitations, 10 audit events per page).

## Effective limits

`effectiveLimits(user, config)` (`src/accounting/limits.ts`) is the one resolution:
- **Per-user overrides** (columns on `app_user`, null = default): saved tasks, active tasks, total daily runs, daily manual runs, active runs, monthly user budget.
- **Environment defaults** otherwise: `TASK_SAVED_LIMIT` 20, `TASK_ACTIVE_LIMIT` 5, `USER_DAILY_RUN_LIMIT` 10, `USER_DAILY_MANUAL_RUN_LIMIT` 5, `USER_ACTIVE_RUN_LIMIT` 1, `USER_MONTHLY_BUDGET_USD` (no default). These are configurable beta defaults, not approved final numbers.
- **Not overridable per user:**
  - the global monthly budget, the queue limit and research concurrency;
  - model, pricing and provider request bounds;
  - live research staying administrator-only;
  - fail-closed accounting configuration. Live research needs the environment budgets and pricing; an override never turns a missing budget into unlimited or free access.

**Override names and bounds:**
- `tasks`, `active_tasks`, `daily_runs` and `manual_runs`: integers 0–1000;
- `active_runs`: integer 0–100;
- `budget_usd`: a USD amount with at most 6 decimals;
- `default` clears an override.

0 is allowed and means "none". A database check enforces the same bounds.

**Used by every path:**
- task creation, Save and Resume (saved/active tasks);
- admission for `/research`, Run now and scheduled occurrences (active runs, total daily quota, manual quota, user budget);
- retry authorization (user budget, under the owner's row lock);
- `/usage` and the administrator views.

**Semantics unchanged:**
- the total daily quota counts manual and scheduled admissions;
- the manual quota applies to `/research` and Run now only;
- UTC days and months, and runs cancelled before submission do not count;
- admission stays atomic under the global admission lock;
- reservations keep their pricing snapshot.

**Lowering a limit:**
- Existing saved tasks, runs, reservations and exposure are not changed.
- New operations beyond the limit are refused: a new task or resume, or a new admission or retry reservation.
- A lowered budget never releases exposure.

**Serialization.** A limit change updates the target's row under its row lock. Admission and task operations read the user under the same lock (identity lock, then the row FOR UPDATE), so a change committed first is respected and a later one waits. The integration test holds the row in another session and shows the admission waiting, then refusing under the new limit.

**Audit.** `LIMIT_CHANGED` records:
- actor and subject;
- the limit name, the override before and after, the effective value before and after;
- the administrator's reason, at most 200 characters.

## Aggregate usage and failures

`/admin usage` uses the accounting definitions of TRB-050 through `sumComponents`, which `/usage` and run history share. A partially known UNRESOLVED reservation counts its estimate as estimated and only the rest as unresolved.

The view keeps these distinctions:
- **Amounts.** Application estimates (estimated, unresolved, reserved) are shown separately from operator-confirmed amounts, and labelled as not an OpenAI invoice.
- **Outcomes.** The execution outcome (run states, failure codes) is shown separately from delivery outcomes (sent, unknown, not delivered, suppressed, waiting).
- **Open cases.**
  - live UNCERTAIN runs without provider reconciliation (`ops:reconcile`);
  - UNRESOLVED reservations, and SETTLED ones with an uncertain hold (financial resolution, `ops:accounting`);
  - recorded destination refusals not yet applied;
  - unavailable chats.

No billing lookup and no automatic reconciliation are performed.

**Corrections after resolution** (the TRB-050 commitment):
```
npm run ops:accounting -- --correct --run <id> --confirmed-usd <amount> --operator <name> --note "<billing evidence>"
```
- **Scope.** Only a RESOLVED reservation can be corrected.
- **Ledger.** It appends a `CORRECT` entry with the operator, the note, the previous amount and a correction number. Earlier entries are never rewritten (the ledger stays append-only).
- **Reservation.** It stays RESOLVED, with the new confirmed amount as its exposure.
- **No-op refused.** The same amount is refused (`SAME_AMOUNT`).

## Audit events

New kinds:
- `LIMIT_CHANGED`;
- `INVITATION_REVOKED`: the number of suppressed deliveries.

Existing kinds (invitations, redemption, suspension, reactivation, administrator bootstrap, destination block and restore) are unchanged. Audit events stay append-only and content-free. The inbox's duplicate protection means a replayed update writes no second event.

## Migration (`20261021150000_trb_090_admin_retention`)

Additive:
- limit columns on `app_user`, with a bounds check;
- `invitation.revoked_at` and `revoked_by_user_id`;
- enum values `LIMIT_CHANGED`, `INVITATION_REVOKED` (audit) and `CORRECT` (ledger);
- the retention markers (docs/RETENTION.md).

No existing row is changed: all overrides are null, so every user keeps the environment defaults.

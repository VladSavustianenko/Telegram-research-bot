# TRB-030: identity, invitations, onboarding and authorization

Status: READY FOR REVIEW (review fixes for commit 6540e6a applied 2026-10-19: durable suppression, current access at delivery). Validated with fake providers, a recording Telegram sender and real PostgreSQL only; nothing here was exercised against the real Telegram API.

## Identity

- **Identity is the Telegram user ID.** It is the immutable `from.id` of a verified update, stored as `bigint` in `app_user.telegram_user_id`. A trigger rejects changes to it. IDs outside JavaScript's safe-integer range are rejected at parsing, never rounded.
- **No profile data.** Usernames and display names are not stored.
- **Private chat only.** User operations run only when the update comes from a non-bot sender in that sender's own private chat (`chat.type = private` and chat ID equal to sender ID).
  - Group, supergroup and channel updates, bot senders and mismatched chats are recorded in the inbox as `IGNORED` and get no reply.
  - They never reach user lookup, invitation redemption or research admission.
- **Record (`app_user`).** Role (`ADMIN` or `MEMBER`), status (`ACTIVE` or `SUSPENDED`), onboarding state (`AWAITING_TIME_ZONE` or `COMPLETED`), confirmed time zone, `revision`, `invited_at`, `onboarded_at`, `suspended_at` and the private chat ID.
  - `revision` is incremented on every onboarding or lifecycle change and is carried by buttons.
  - The private chat ID must equal the user ID (a check constraint).

### Administrator bootstrap (`ADMIN_TELEGRAM_IDS`)

The configuration is authoritative for the administrator role. The stored role is a mirror kept for queries. Authorization requires both: the stored role `ADMIN` and the ID present in the current `ADMIN_TELEGRAM_IDS`.

| Event | Effect |
|---|---|
| Startup | `bootstrapAdministrators` runs once. It is idempotent and safe to run concurrently. It is skipped when `ADMIN_TELEGRAM_IDS` is unset. A failure (for example, an unreachable database) is logged and not fatal. |
| Configured ID without a record | A record is created with role `ADMIN`, status `ACTIVE` and onboarding `AWAITING_TIME_ZONE`. The same happens on that user's first update if startup bootstrap did not run. No invitation is consumed. |
| Configured ID with role `MEMBER` | The role becomes `ADMIN`. |
| ID removed from the list | The role becomes `MEMBER` at the next startup or on the user's next update. That user had no invitation (`invited_at` is null), so they now have **no account**: they get the invitation-required reply and their queued runs are cancelled before submission (`ACCESS_REVOKED`). They can regain member access only by redeeming an invitation. A former administrator who had also redeemed an invitation keeps member access. |
| Suspended user added to the list | The role becomes `ADMIN`, but the status stays `SUSPENDED`. Bootstrap never changes status, so it never reactivates anyone; another administrator must use `/admin reactivate`. |
| Every role change | An `ADMIN_GRANTED` or `ADMIN_REVOKED` audit event (actor null, source `ADMIN_TELEGRAM_IDS`). |

## Account access

Every entry point uses the pure rules in `src/identity/authorization.ts`, with the user record loaded for the authenticated sender. Nothing trusts IDs from message text or callback data.

| Access | Condition | Allowed |
|---|---|---|
| NONE | No record; or a record that is neither a configured administrator nor has redeemed an invitation | `/start <invitation>` only; everything else gets "Цей бот приватний. Доступ лише за запрошенням." |
| SUSPENDED | Status `SUSPENDED` (checked first, for everyone) | Nothing; reply "Ваш доступ призупинено адміністратором." |
| ONBOARDING | Active, onboarding not completed | Time-zone confirmation; `/admin …` for administrators |
| ACTIVE | Active, onboarding completed | `/research`, `/result`, `/help`; `/admin …` for administrators |

Application services check authorization themselves, as well as the inbox router:
- research admission: `researchAdmissionDenial`;
- stored-result resend: `userOperationDenial`;
- administrator commands: `adminOperationDenial`;
- the research worker before submission: `submissionDenial`.

## Commands and onboarding flow

| Command | Who | Effect |
|---|---|---|
| `/start <token>` | Sender without an account | Redeems the invitation, then asks for the time zone |
| `/start` | Anyone | Without an account: invitation-required reply. During onboarding: the time-zone prompt. Otherwise: help. A token sent by someone who already has an account (member, administrator) is **not** consumed. |
| `/help` | Active users | Help; administrators also see the `/admin` commands |
| `/research <prompt>`, `/result <run-id>` | Active users with completed onboarding | See docs/RESEARCH_SLICE.md; scoped to the sender's own runs |
| `/admin`, `/admin invite`, `/admin suspend <Telegram ID>`, `/admin reactivate <Telegram ID>` | Active configured administrators | See below. Anyone else gets the unknown-command reply, which does not disclose that the command exists. |

### Onboarding

1. **Invitation accepted.** The bot replies "Вітаємо! Запрошення прийнято." and asks the user to confirm a time zone. It suggests `Europe/Kyiv` with a button "Підтвердити Europe/Kyiv".
2. **Other zone.** The user may instead send an IANA name as plain text, for example `America/New_York`.
   - Input is case-insensitive.
   - Only region names (`Area/Location[/Sub]`) and `UTC` are accepted. Abbreviations such as `EST`, offsets such as `+03:00` and unknown zones are rejected with "Невідомий часовий пояс…".
   - A valid name is not saved immediately. The bot asks "Підтвердити часовий пояс X?" with buttons for X and for Europe/Kyiv.
3. **Confirmation.** Pressing a button completes onboarding: it stores the zone, sets `COMPLETED` and `onboarded_at` and increments `revision`. The bot confirms and shows help.
4. **Before completion,** `/research` and `/result` reply "Спершу завершіть реєстрацію: підтвердіть часовий пояс." and repeat the prompt with buttons. No run is created.
5. **Restarts.** The state lives in `app_user`, so onboarding survives restarts. A button issued before a restart still works if the user's revision has not changed.

The confirmed zone is used as the time zone of the user's research runs, stored in the run snapshot. `RESEARCH_TIME_ZONE` is only a fallback. Changing the zone after onboarding (`/settings`) and scheduling are not implemented; the stored IANA name is ready for them.

### Button (callback) format

`tz:<revision>:<zone>`, at most 64 bytes. The data never contains a user, run or owner ID. A press acts only on the presser's own record and only when all of these hold:
- it comes from the presser's own private chat;
- the presser has an account in onboarding;
- `<revision>` equals the presser's current revision;
- `<zone>` is valid.

The confirming update is conditional on the revision, the onboarding state and `ACTIVE`, so concurrent or replayed presses confirm once. Any other press changes nothing and creates no message. It only gets a best-effort acknowledgement (`answerCallbackQuery`) such as "Ця кнопка застаріла." or "Часовий пояс уже підтверджено: …". Recorded reasons:
- `CALLBACK_STALE`;
- `CALLBACK_UNKNOWN`;
- `TIME_ZONE_INVALID`;
- `TIME_ZONE_ALREADY_CONFIRMED`;
- `NOT_REGISTERED`;
- `NOT_PRIVATE_CHAT`;
- `CHAT_SENDER_MISMATCH`.

Polling requests `allowed_updates = ["message", "callback_query"]`. A webhook must be registered with the same list (TRB-100).

## Invitations

- **Creation.** `/admin invite` (active configured administrator) creates one invitation. It expires after `INVITATION_TTL_HOURS`, default 168 h (7 days, the README's proposed default), at most 720 h. Expiry uses database time.
- **What the administrator receives.**
  - The link `https://t.me/<TELEGRAM_BOT_USERNAME>?start=<token>`, or `/start <token>` when `TELEGRAM_BOT_USERNAME` is not set.
  - The expiry in the administrator's time zone.
  - A warning that whoever uses the link first gets access. Forwarding is an accepted beta tradeoff (SPEC §2).
- **Token.** `base64url(HMAC-SHA256(INVITATION_TOKEN_SECRET, "trb-invitation-v1:" + invitation_id))`: 43 characters of `[A-Za-z0-9_-]`, valid as a Telegram deep-link payload.
  - The invitation ID is a random UUID, so the token is unpredictable without the secret.
- **Storage.** Only `SHA-256(token)` is stored (`invitation.token_hash`, checked as 64 hex digits).
  - The message that carries the link is stored with a placeholder (`delivery_part.html` contains `{{INVITATION_TOKEN}}`; delivery kind `INVITATION`).
  - The delivery worker derives the token only for that delivery kind, just before sending. It checks the derived token against the stored hash: a rotated secret gives `PERMANENT_FAILURE / INVITATION_TOKEN_UNAVAILABLE` instead of an invalid link.
  - As a result, no table contains a usable token: `telegram_update` stores no text, `delivery_part` holds the placeholder, and `audit_event` and `invitation` hold no token. Neither do the logs. Tests search all of them for the token.
- **Without `INVITATION_TOKEN_SECRET`** (at least 32 characters), `/admin invite` replies that invitations are not configured.
- **Rotating the secret** invalidates only links whose message has not been sent yet. Already-sent links keep working until they expire, because redemption only hashes the presented token.
- **Redemption.**
  - **Who may redeem.** `/start <token>` in a private chat, from a sender **without an account** (`mayRedeemInvitation`).
    - Members, administrators and suspended users never consume an invitation.
    - Group messages never reach redemption.
  - **Effect.** In the inbox transaction, under the sender's identity lock, it does the following:
    1. Locks the invitation row with `FOR UPDATE WHERE token_hash = … AND redeemed_at IS NULL AND expires_at > now()`.
    2. Creates the user: role `MEMBER`, `ACTIVE`, `invited_at` set. A record without access (a removed administrator) is updated instead.
    3. Marks the invitation redeemed by that user.
    4. Links the user's earlier runs by Telegram identity.
    5. Appends `INVITATION_REDEEMED`.
    6. Notifies the inviting administrator with the new user's Telegram ID only.
  - **Never administrator.** An invitation never grants `ADMIN`.
- **Exactly one winner.** A concurrent redeemer of the same token waits on the row lock. After the winner commits, PostgreSQL re-evaluates the condition on the new row version, so it gets no row. `redeemed_by_user_id` is unique, and a check keeps `redeemed_at` and `redeemed_by_user_id` together.
- **Failures.** Malformed, unknown, expired and already-used tokens all get the same reply: "Запрошення недійсне, прострочене або вже використане…". No user is created, and nothing about the invitation or its user is disclosed.

## Inbox and duplicate updates

The TRB-020 inbox (`telegram_update`) remains the only deduplication mechanism. Each update is handled in one transaction:
1. `INSERT … ON CONFLICT (update_id) DO NOTHING`. A replay finds the row and does nothing; a concurrent replay waits for the first transaction, then does nothing.
2. A per-sender transaction advisory lock serialises all updates of one Telegram identity, including senders without a record yet.
3. The sender's `app_user` row is loaded `FOR UPDATE`.
4. Routing and business actions, with their reply deliveries.
5. The inbox row gets its final disposition and reason. It stores no message text, callback data or token. A run ID is stored only for the sender's own run.

All actions are idempotent under replay: redemption, invitation creation, time-zone confirmation, suspension, research admission and resend. Callback acknowledgements are sent after commit and are best effort.

## Ownership

- **`research_run.user_id`** is the owner. A trigger requires it to match `requested_by_telegram_user_id` and forbids changing it once set.
- **Scoped access.** `/result` looks up the run with `id AND user_id = <authenticated user>`. A foreign ID and a nonexistent ID produce the same reply ("Запуск не знайдено.") and no `RESEND` delivery. Administrators cannot read other users' results either.
- **Delivery.** Deliveries are linked to runs. Before each part of a run-related delivery, the delivery worker rechecks the owner's current account access (see [Delivery-time access](#delivery-time-access)).

## Suspension

`/admin suspend <Telegram ID>` (active configured administrator; the target must exist and must not be an administrator by role or configuration). Repeating it changes nothing.

In one transaction, under the target's row lock:
- status `SUSPENDED`, `suspended_at` set, `revision` incremented;
- every `QUEUED` or `RUNNING` run of the user gets a **durable decision**, `research_run.delivery_suppressed_at`;
- `QUEUED` runs become `CANCELLED / USER_SUSPENDED`. They were never submitted, so no provider request exists;
- every unfinished delivery of the user's runs (`PENDING`, `RETRYABLE_FAILURE` or `SENDING`) gets a **durable decision**, `delivery.suppressed_at`. Waiting ones become `SUPPRESSED / RECIPIENT_SUSPENDED`; one being sent keeps its state until the worker stops it before its next part;
- a `USER_SUSPENDED` audit event with counts: cancelled runs, suppressed deliveries and running runs.

### Durable suppression

The decisions are stored on the affected run and delivery rows, not derived from the user's current status, and **nothing clears them**: reactivation, restarts and recovery leave them in place. A check constraint requires every `SUPPRESSED` delivery to carry its decision.

| Affected work | Effect of the decision |
|---|---|
| Queued run | Cancelled; its acknowledgment is suppressed |
| Running request | Polling requests provider cancellation (it checks the run's decision, so it also does after an early reactivation). Response ID, usage and telemetry are kept. Confirmed `cancelled`: `CANCELLED / USER_SUSPENDED`. `completed` with confirmed bounds: the report is stored (SUCCEEDED). No terminal answer: `UNCERTAIN / SUSPENDED_CANCEL_UNCONFIRMED`, which for a live run blocks live work until reconciliation |
| Report or status message created later by that run | Created directly as `SUPPRESSED`, with its parts stored |
| Waiting delivery | `SUPPRESSED` immediately |
| Delivery being sent | The worker reads `suppressed_at` in the transaction that marks the next part `SENDING`, and finishes `SUPPRESSED`. Parts already `SENT` keep their Telegram message ID |
| Delivery being sent when the worker dies | Lease recovery: a part that was in flight becomes `UNKNOWN` and the delivery `UNKNOWN`, never retried automatically. With no part in flight, the delivery becomes `SUPPRESSED` instead of `PENDING` |

**Coordination with report creation.** Suspension first sets the run decision, then suppresses deliveries in a later statement. The worker's completion transaction locks the run row (fenced update), then reads the decision and creates the report delivery:
- **Suspension first.** If the suspension updates the run first, the completion waits for its commit and then sees the decision.
- **Completion first.** If the completion holds the row first, the suspension waits for its commit. The later delivery statement then sees, and suppresses, the new `PENDING` report.

Either way no automatically deliverable report remains for the affected work. The integration test pauses the completion transaction while it holds the run row and makes a second process's suspension wait on it.

### Reactivation and explicit resend

`/admin reactivate <Telegram ID>` restores `ACTIVE` and appends `USER_REACTIVATED`. Cancelled runs and suppressed deliveries stay as they are: no backlog is delivered automatically (SPEC §2).
- **Explicit resend.** The reactivated user may request `/result <run-id>` for their own run. It creates a **new** `RESEND` delivery from the stored report parts. The stored decisions do not apply to it, because they are attached to the earlier rows. The suppressed automatic delivery is not reopened, and the provider is not called.
- **New research** admitted after reactivation is delivered normally.

While suspended:
- **Admission.** New research, `/result`, invitations and buttons are refused. Admission reads the user under the same row lock, so it is serialised with suspension.
- **Execution recheck.** Before any new submission, the worker reads the owner `FOR SHARE` in the transaction that records `SUBMITTING`.
  - A suspended owner gets `CANCELLED / USER_SUSPENDED` with zero provider calls. The same applies to an unresolved owner (`OWNER_UNRESOLVED`) and an owner who lost access (`ACCESS_REVOKED`).
  - Either the suspension commits first, and the run is cancelled, or `SUBMITTING` commits first, and the request goes out.
- **Preserved.** Saved results, provider evidence, tool telemetry and reconciliation records are kept.

**Race boundaries** (documented, not eliminated):
- **Submission.** A suspension committed just after `SUBMITTING` lets that one request reach the provider. Cancellation is requested on the next poll, about `OPENAI_POLL_INTERVAL_MS` later, and the request may still incur cost.
- **Delivery.** A part already marked `SENDING` before the suspension committed may still be delivered; it cannot be retracted. If the outcome is confirmed, the part is `SENT`; if it is ambiguous, `UNKNOWN`. No later part starts.

**Legacy limitation.** Before migration `20261019120153_trb_030_durable_suppression`, suspension stored no per-run or per-delivery decision. The migration:
- gives already `SUPPRESSED` deliveries a decision timestamp;
- records the decision for the `QUEUED`/`RUNNING` runs and `SENDING` deliveries of users who are **suspended at migration time**.

Work affected by an earlier suspension that was already reactivated left no evidence and cannot be reconstructed. Its waiting deliveries were already `SUPPRESSED` (terminal), but a report created later by a run that was in flight then is not covered.

Operational handling: before applying the migration, check `audit_event` for `USER_REACTIVATED`. For each reactivated user, inspect their runs that completed after the suspension. The development database had no suspension events.

## Delivery-time access

Before each part of a **run-related** delivery (automatic report, explicit resend, run status notice), the delivery worker reloads the run's owner and applies `runDeliveryDenial` with the current configuration:
- **Unresolved owner:** `OWNER_UNRESOLVED`.
- **Suspended:** `RECIPIENT_SUSPENDED`.
- **No account:** `ACCESS_REVOKED`. For example, an administrator removed from `ADMIN_TELEGRAM_IDS` who never redeemed an invitation; this holds even if the stored role is still `ADMIN`, because `isAdministrator` requires the current configuration.

A denial ends the delivery `SUPPRESSED` with that code and a decision timestamp, so it is final even if access is restored later.

Only account access counts:
- A former administrator who redeemed an invitation is still a member and keeps receiving their own reports and resends.
- Onboarding is not required.
- The separate administrator-only rule for **new live research** (admission and submission) is unaffected.

Replies that are not about a run (help, invitation-required, onboarding prompts, administrator replies, invitation links) are not subject to this rule.

## Research access before TRB-050

- **Simulated research.** Invited active members with completed onboarding may use it (`RESEARCH_MODE=fake`).
- **Live (paid) research** stays administrator-only until TRB-050 budgets are implemented and accepted:
  - **At admission:** a member's live request is refused ("Live-дослідження поки доступні лише адміністраторам…"). No run is created, and it is never replaced by simulated research.
  - **At execution:** a queued live run whose owner is not a configured administrator becomes `CANCELLED / LIVE_NOT_PERMITTED` before submission.
- **Unchanged from TRB-020:** the fail-closed gate for unresolved live UNCERTAIN runs, immutable run snapshots, fencing and no automatic resubmission.

## Migration and backfill (`20261019111654_trb_030_identity`)

- **Additions.**
  - Tables `app_user`, `invitation` and `audit_event`; the latter is append-only, enforced by a trigger.
  - Columns `research_run.user_id`, `delivery.invitation_id` and `delivery_part.reply_markup`.
  - Enum values `ResearchRunState.CANCELLED`, `DeliveryState.SUPPRESSED` and `DeliveryKind.INVITATION`.
  - Checks and triggers: identity immutability, onboarding/time zone, suspension consistency, redemption consistency, the token-hash format, invitation deliveries, owner consistency, and the extended failure-code check. Foreign keys use `ON DELETE RESTRICT`.
- **Existing records.** The migration changes no existing row; all existing runs keep `user_id = NULL`.
  - **Ownership is linked by the application, by stored Telegram identity only.** Administrator bootstrap links the runs of configured administrators. Invitation redemption links the runs of the redeeming identity.
  - `updated_at` of linked runs is not changed. Nothing is assigned to any other user.
- **Runs whose identity has no record** stay unowned (fail closed):
  - not visible through `/result`;
  - their deliveries are suppressed (`OWNER_UNRESOLVED`);
  - a queued one is cancelled before submission (`OWNER_UNRESOLVED`).

  Operator resolution: invite that Telegram user (redemption links their runs) or add the ID to `ADMIN_TELEGRAM_IDS`. Do not assign owners manually.
- **Preserved unchanged:** reports, delivery parts, tool telemetry, reconciliation audit and UNCERTAIN evidence. An unreconciled live UNCERTAIN run of an unowned identity still blocks live work.
- **Administrators must onboard.** After the upgrade, existing administrators must confirm a time zone (`/start`) before using `/research` again.

The follow-up migration `20261019120153_trb_030_durable_suppression` adds `research_run.delivery_suppressed_at` and `delivery.suppressed_at` (nullable; see [Durable suppression](#durable-suppression) for its handling of existing rows and its legacy limitation) and the check `delivery_suppressed_has_decision`.

Verified against a database containing representative TRB-020 records (`test/integration/identity-migration.int-spec.ts`) and applied to the local development database (docs/VALIDATION.md).

## Audit

`audit_event` holds identifiers, codes and counts only: no tokens, prompts or report content. UPDATE and DELETE are rejected. Events:
- `ADMIN_GRANTED`, `ADMIN_REVOKED`;
- `INVITATION_CREATED` (TTL);
- `INVITATION_REDEEMED` (whether an existing record was converted, number of linked runs);
- `USER_SUSPENDED` (counts);
- `USER_REACTIVATED`.

Viewing them is deferred to TRB-090.

## Deferred

| To | Items |
|---|---|
| TRB-040 | `/settings` (changing the time zone after onboarding), task CRUD, persisted drafts |
| TRB-050 | Budgets and quotas; then live research for members |
| TRB-080 | Blocked-destination handling; a fresh `/start` revalidating the chat |
| TRB-090 | Administration views (users, invitations, audit), invitation revocation, limits, retention |
| TRB-100 | Webhook registration with `allowed_updates = ["message", "callback_query"]` |

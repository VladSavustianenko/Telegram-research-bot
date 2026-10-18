# Product specification

## 1. Goal and scope

Let invited users create independent research tasks and receive sourced reports in Telegram. Examples: weekly football fixtures, clothing offers under a price threshold, political news, and stock-market news matching criteria. Users write their own prompts. No inventory verification in physical shops is promised.

MVP supports private chats only, Ukrainian UI, configurable result language through the prompt, daily/weekly/manual schedules, manual runs, task editing/pause/delete, latest result/history, citations, per-user usage controls and admin actions. Do not build free-form conversational administration, Telegram Mini Apps, group/channel delivery, payments, user-supplied API keys, change-only alerts, custom data feeds or scraping.

## 2. Users and access

Identify a user with immutable Telegram user ID. Store identifiers as bigint-compatible values and serialize as strings at boundaries. Telegram username is optional display metadata. A private chat must be established by the user before delivery.

Bootstrap administrators from configured Telegram IDs. Unknown users see an invitation-required response without task or account details. An administrator issues a random single-use invitation with expiry; store its hash, never the plaintext token. Redeem atomically, bind to the redeeming Telegram identity, and reject reuse/expiry. Forwarding an unused invitation allows its first recipient to redeem it: this is an accepted beta tradeoff.

Users: ACTIVE or SUSPENDED. Suspension rejects new work, cancels queued work, suppresses delivery and requests cancellation of running work where supported. Already-issued provider requests may still incur cost. Resumption does not deliver an accumulated backlog automatically. Administrators manage access and usage, not other users' prompt/result content through the MVP UI.

Every user-facing task, run and delivery action checks ownership, including callbacks, pagination and replayed messages. No existence leak for foreign IDs. Reject group/supergroup/channel commands.

## 3. Telegram interface

Commands: /start, /help, /tasks, /new, /settings, /usage, /cancel; administrator-only /admin. Prefer inline buttons for routine actions.

Onboarding: redeem invitation, confirm time zone, show usage limits, then open task list. Suggest Europe/Kyiv but require confirmation; Telegram does not supply a reliable IANA time zone. Other zones can be entered as validated IANA names.

Creation flow: name → prompt → manual/daily/weekly → day if weekly → local time if scheduled → time zone → preview → save. A manual task needs no local time. Saving never starts a paid run automatically. Offer a separate Run now button. Include Back/Cancel, validation messages and a saved draft. Draft expires after 24 hours of inactivity (proposed default).

Task card shows name, prompt preview, active/paused status, schedule, time zone, next execution and latest run state. Actions: Run now, Pause/Resume, Edit prompt/name/schedule, Latest result, History, Delete. Deletion requires confirmation. Editing uses a version check; a stale callback refreshes the card rather than overwriting new settings.

Settings time zone is the default for new tasks. Each task retains its own zone; changing the user default does not silently shift existing schedules. History uses paginated recent runs with status, time, estimated usage and a result button.

Proposed input limits: 100-character name, 8,000-character prompt, 5 active tasks/user. Limits are configurable. Paused tasks remain visible; cap total saved tasks separately to prevent unbounded storage.

## 4. Scheduling semantics

Daily means once at a local HH:mm; weekly means one selected weekday at HH:mm. Manual-only tasks have no next scheduled execution. Store IANA zones and UTC instants; never hard-code Kyiv's offset.

DST policy: nonexistent local time runs at the first valid local time after the gap; ambiguous local time runs only at the earlier occurrence. Test this policy explicitly. Scheduler advances from planned local occurrences, not from actual completion time.

After downtime, create at most one catch-up run for the latest missed occurrence when it is no older than 24 hours. Mark older occurrences skipped in operational history and advance to the next future occurrence. Scheduled and actual start times are separate. Research uses the actual execution's current time as its reference and discloses delays; it must not claim it ran in the past.

At most one QUEUED/RUNNING run per task. A manual click while active returns the existing run status. A scheduled overlap is recorded as skipped; it does not create a later burst. Pause cancels queued research; running research may finish and deliver unless the task was deleted or the user suspended. Resume calculates the next future occurrence without catch-up. Manual run remains available for a paused task, subject to quotas.

Editing a prompt/schedule does not mutate a running run's immutable snapshot. Cancel queued runs based on old settings, release reservations and recompute future schedule. Deletion soft-deletes the task, cancels queued work and suppresses future delivery, including results from already-running work.

Schedule and search period are distinct. Always supply current UTC/local time and calendar boundaries. Interpret explicit phrases such as current week, previous seven days and next seven days in the task zone. Prompts with no explicit period retain their wording; do not invent a hidden universal time window. The setup preview encourages explicit periods for time-sensitive topics.

## 5. Research and results

Use OpenAI Responses API with required web search for every research execution. The selected model must support the chosen tools and limits. Users cannot choose arbitrary models or bypass limits through prompts.

Persist the exact prompt revision, system policy version, model/configuration, context dates, provider response ID when available, text, annotations, usage and timestamps. Poll incomplete asynchronous responses until terminal state within a deadline; never deliver partial provider output as a completed report.

Ground factual claims in sources. Prefer primary sources when feasible; distinguish publication date from event date, and evidence from inference. Never treat absence of search results as proof that something does not exist. State unknown prices/availability rather than inventing them. Search failure is not an empty result.

Result outcomes: FOUND, PARTIAL, NO_MATCHES, INCONCLUSIVE. Technical execution failure is FAILED, separate from these content outcomes. If a provider response cannot reliably be classified, use INCONCLUSIVE; never silently label it NO_MATCHES. Do not require a second model call just to classify or beautify output.

Results include task name, checked-at time/zone, requested period when explicit, main findings, limitations, and clickable inline citations. Preserve provider citation annotations; a URL written by the model alone is not evidence that it was consulted. At least one citation is required for a sourced factual report; missing citations cause a quality warning/inconclusive outcome, not invented sources.

Render safe Telegram HTML, split at semantic boundaries within Telegram limits, and persist the final chunks before sending. Proposed maximum: six report chunks; mark truncation visibly. Offer stored full text as a text document when the report exceeds this bound. Resending a stored result is a delivery action, not a new research run.

## 6. Quotas and cost

One server-owned OpenAI credential; attribute all attempts to users/runs. Configurable controls: saved/active tasks, daily admitted runs, daily manual runs, user monthly USD allowance, global monthly USD allowance, global/user concurrency, maximum response/tool/output limits and timeouts. Accounting periods use UTC explicitly; display that in /usage.

Suggested beta defaults: five active tasks, twenty saved tasks, ten total admitted runs/user/day, five manual runs/user/day, one concurrent research/user and one globally. These are proposals, not owner-approved final numbers. Dollar budgets and model/pricing require explicit operator configuration; fail closed for paid research if missing.

Reserve an estimated conservative maximum cost atomically before accepting a run; reconcile actual reported usage afterward. Store a versioned pricing snapshot and mark costs as estimates. Account for tool charges and model-specific token billing. Retries require additional reservation. Unknown provider costs stay reserved pending reconciliation; never assume zero.

Application budgets limit admission and bound requests, but do not guarantee an exact provider-invoice ceiling during ambiguous failures. Finite request controls and concurrency reduce exposure. Failed attempts can incur charges. Quota/budget denial is explained to the user; repeated clicks are throttled and do not spawn work.

## 7. Privacy and operations

Inform users that prompts are sent to OpenAI and reports are stored. Keep prompts/results out of routine logs. Secrets are environment-managed. Default proposed retention: report bodies/snapshots 30 days, redacted run/usage metadata 90 days; preserve unresolved reservations until settled. Make retention configurable and document deletion behavior. Task deletion hides history from normal navigation and schedules retained content for purge according to policy; do not promise immediate provider-side deletion.

Delivery failures show a recoverable state. A blocked bot marks the destination unavailable and pauses automatic research to avoid accumulating paid undeliverable reports. A new /start revalidates the chat and asks the user to resume tasks explicitly.

An administrator can invite/suspend/reactivate users, set limits and inspect aggregate usage/failures. System-level failures are visible through health checks and structured logs. No automatic messages to arbitrary third parties.

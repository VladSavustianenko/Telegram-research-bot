# TRB-090: retention and data lifecycle

What is stored, for how long, and how cleanup removes content without weakening accounting, delivery or recovery guarantees.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `RETENTION_CLEANUP` | `off` | Cleanup runs only when `on` (and with `BACKGROUND_WORKERS=on`). Off by default: enabling it permanently removes stored content |
| `REPORT_RETENTION_DAYS` | 30 | Content age limit (SPEC §7 proposal), 1–3650 |
| `METADATA_RETENTION_DAYS` | 90 | Inbox and queue bookkeeping age limit (SPEC §7 proposal), 7–3650 |
| `RETENTION_INTERVAL_SECONDS` | 3600 | Pause between passes (a pass that filled a batch continues at once) |
| `RETENTION_BATCH_SIZE` | 50 | Items per category per pass, ≤ 500 |

These are proposals for the owner. The owner's development database was migrated, but cleanup stays off there; nothing was purged from it.

## Inventory and retention matrix

**Content** is user- or model-authored text. **Evidence** is what accounting, delivery, recovery or audit depend on.

| Data | Where | Kind | Age reference | Action after the period | Exceptions (kept) |
|---|---|---|---|---|---|
| Run prompt (`/research` text or task prompt copy) | `research_run.prompt` | Content | Run completion (terminal time) | Replaced by `[deleted]`; `content_purged_at` set | Run not finished; live UNCERTAIN run without provider reconciliation; any reservation RESERVED or UNRESOLVED; a delivery of the run being sent (retried next pass) |
| Request snapshot | `research_run.request_snapshot` | Content (`request`) + evidence (`config`, `task`, `accounting`) | Run completion | The built `request` (prompt and context) is removed; model, bounds, zone, task ID/revision and the accounting snapshot stay | Same as above |
| Report text, citations, consulted sources | `research_run.report_text`, `citations`, `sources` | Content | Run completion | Cleared | Same as above |
| Report and document parts, resend copies, the run's status messages | `delivery_part.html`, `reply_markup`, `file_content` of deliveries with `run_id` | Content | **The run's completion**, not the resend's time: resends never extend it | Payload emptied through the one allowed purge path; `content_purged_at` set | Same as above |
| Waiting copies of an expiring run (PENDING, RETRYABLE_FAILURE) | `delivery` | — | Run completion | Finalized `SUPPRESSED / CONTENT_EXPIRED`, wake-ups cancelled, the next delivery to the chat woken | A delivery being sent (`SENDING`): the run is skipped this pass |
| Other messages: replies, task cards, history and run cards (prompt previews), draft views, invitation messages | `delivery_part` of deliveries without `run_id` | Content | The delivery's last change, once finished | Payload emptied | Unfinished deliveries |
| Deleted task name and prompt | `task.name`, `task.prompt` | Content | `deleted_at` | `[deleted]`; edit drafts still copying the task are deleted | Active and paused tasks are never touched: their configuration is needed for future runs |
| Drafts | `task_draft.data` | Content | `expires_at` (24 h of inactivity) | Deleted | Unexpired drafts |
| Invitation token hash | `invitation.token_hash` | Secret-derived | Redemption, revocation or expiry | Replaced by `cleared:<id>`; the row stays (audit references it) | Valid invitations |
| Inbox records | `telegram_update` | Metadata (no text) + deduplication key | `received_at` | **Never deleted.** Reduced to a tombstone after the metadata period: `update_id`, disposition and receipt time stay; sender, chat type, reason, run link and the verified-private marker are cleared (`metadata_redacted_at`, check `telegram_update_tombstone_minimal`) | A user's records stay complete while a recorded destination refusal of that user's chat is pending; it may still be superseded |
| Queue bookkeeping | `outbox_event`, `delivery_event` | Metadata | Dispatch or cancellation | Deleted after the metadata period | Events of unfinished runs or deliveries |
| Schedule history | `schedule_event` | Metadata (codes) | Creation | Deleted after the metadata period | — |
| pg-boss jobs | `pgboss.job` | Transport (IDs only) | pg-boss retention (7 / 14 days) | pg-boss deletes them | — |
| Run metadata after redaction | `research_run` (state, outcome, warnings, usage, response IDs, times) | Evidence | — | **Kept** | — |
| Attempts, reservations, ledger, reconciliations, pricing versions | `research_attempt`, `budget_reservation`, `usage_ledger`, `research_reconciliation`, `pricing_version` | Accounting evidence | — | **Kept**: append-only ledger and reconciliation, budget exposure | — |
| Tool telemetry | `research_tool_item` | Evidence (no queries, no URLs) | — | Kept with the accounting it explains | — |
| Delivery records after redaction | `delivery` and part metadata | Evidence | — | **Kept**: states, `UNKNOWN`/`SUPPRESSED` evidence, Telegram message IDs, content hashes, recorded destination refusals | — |
| Audit events | `audit_event` | Evidence (no content) | — | **Kept** (append-only) | — |
| Users | `app_user` | Identity metadata | — | Kept | — |

**Policy decision for the owner (suggested change to SPEC §7).** SPEC proposes deleting "redacted run/usage metadata" after 90 days. This version keeps the redacted run records and all accounting evidence (attempts, reservations, ledger, reconciliations), which hold no user text:
- **Budget exposure.** Deleting them could remove exposure and reopen an exhausted budget.
- **Append-only evidence.** The ledger and reconciliation tables are append-only by trigger.
- **Deduplication.** Retained runs keep the deduplication of replayed updates (`source_update_id` is unique).

Deleting accounting history needs an explicit accounting-closure decision; it is not implemented.

## How cleanup works

`RetentionService` (`src/retention/`) runs in the application process (no new service), with `BACKGROUND_WORKERS=on` and `RETENTION_CLEANUP=on`. `tick()`/`runPass()` drive it in tests.
- **Cutoffs** come from the injected clock: now − `REPORT_RETENTION_DAYS`, and now − `METADATA_RETENTION_DAYS`.
- **Bounded:** each category handles at most a batch per pass; inbox redaction and event deletions at most 10 batches.
- **No starvation** (review fix). Run candidates are selected in SQL already excluding the protected cases:
  - a live UNCERTAIN run without provider reconciliation;
  - a run with a RESERVED or UNRESOLVED reservation;
  - a run with a delivery being sent.

  Such runs therefore never fill the batch ahead of eligible ones, however old they are. They become candidates again by themselves once reconciled, resolved or sent, since nothing is remembered about them. The filter only selects: `purgeRun` still rechecks every condition under its locks and refuses (`NOT_ELIGIBLE`, `BUSY`) if the state changed after selection.
- **Per run, one transaction**, in the established lock order:
  1. the owner's identity lock, then the user row;
  2. the run row (`FOR UPDATE`), rechecked: still finished, still unpurged, still older than the cutoff, not an unreconciled live UNCERTAIN run;
  3. its deliveries (`FOR UPDATE`): any `SENDING` means BUSY, try again later;
  4. its reservations (`FOR SHARE`, so a resolution in progress is waited for): any RESERVED or UNRESOLVED means not eligible;
  5. finalization of waiting copies, purge of every part, redaction of the run, waking the next delivery in each affected chat.
- **Idempotent and multi-instance safe.** Every change is conditional on "not yet purged". Concurrent cleaners serialize on the same locks, and the second finds nothing to do. Restart needs no state: candidates are recomputed from the database.

**Immutable records.**
- **Delivery parts.** The payload trigger now allows exactly one change: emptying a part once (html `''`, no buttons, no file text) while setting `content_purged_at`. Hash, file name, state and Telegram message ID can never change, a purged part can never be filled again, and a part in flight cannot be purged (checks `delivery_part_purged_empty`, `delivery_part_kind_fields`).
- **Run constraint.** `research_run_succeeded_has_report` now accepts a purged succeeded run without text; the outcome is still required.
- **Untouched.** The ledger, reconciliation and audit append-only triggers.

**Accounting stays exact.**
- **Not deleted.** No reservation or ledger entry is ever deleted or changed by cleanup, so current-period and later exposure is unchanged even with a 1-day content retention (integration test: an exhausted budget stays exhausted after the purge).
- **Unresolved cases.** Runs with unresolved accounting or pending reconciliation keep their content until settled.
- **Resolution race.** A resolution racing with cleanup is waited for, and the run is purged afterwards.

**Replays stay harmless.**
- **Inbox** (review fix). Every processed update ID stays in `telegram_update` forever as a tombstone, whatever the outcome: accepted, denied, ignored or administrative. A replay, at any age, conflicts in the inbox's atomic `INSERT … ON CONFLICT DO NOTHING` and executes nothing.
  - **Retention never deletes a row,** so there is no window between cleanup and a redelivery in which an already processed update could run again.
  - **No ordering assumption.** No maximum-ID watermark is used, so out-of-order or non-monotonic update IDs are never refused.
  - **No new evidence.** A tombstone carries no sender or verified-private marker, and a replay is a duplicate, so neither can become new restoration evidence.
  - **Cost.** One small row per update (ID, disposition, receipt time).
  - **Before this fix.** Inbox records were deleted after the metadata period, which removed replay protection for updates that created no run: a denied `/research`, `/admin limit`, suspension, invitations. Cleanup never ran on the owner's development database (`RETENTION_CLEANUP` unset). There, all 7 inbox records are present and every run's source update has one, so no evidence was lost. Records already deleted elsewhere by the earlier code cannot be reconstructed.
- **Queue.** A redelivered research or delivery job finds a finished run or delivery and does nothing.
- **Pending block decisions** keep the verified private updates that may supersede them (docs/DELIVERY.md).

## Purged results

- **`/result <id>` and the history resend button** answer that the report was removed after N days and cannot be resent. They create no delivery and start no research.
- **Run card** says "Звіт: вміст видалено за політикою зберігання". It shows no resend button and no prompt preview ("текст запиту видалено").
- **History** still lists the run with its states and usage.
- **Waiting deliveries** of an expired run are finalized `SUPPRESSED / CONTENT_EXPIRED`, so later messages to the chat are not blocked.
- **Delivery worker guard.** It never sends a purged part: such a delivery ends `SUPPRESSED / CONTENT_EXPIRED`.

**Task deletion** hides the task and its runs immediately (TRB-040/080). Their content is then removed on the same schedule: the runs' content after their completion plus the period, and the task's name and prompt after the deletion plus the period. Deletion removes local storage only: messages already delivered to Telegram stay in the user's chat, and nothing is deleted at OpenAI. Responses are created with `store=false` (TRB-020) and kept by OpenAI only for the documented polling window.

## User-facing information

`/privacy` (new, listed in `/help`) explains, with the effective configuration:
- prompts are sent to OpenAI in live mode; in simulation they are not;
- reports and prompt copies are kept for `REPORT_RETENTION_DAYS` after completion, or that cleanup is currently off;
- expired reports cannot be resent;
- usage accounting is kept longer, without text;
- local deletion does not remove messages already in Telegram or data at OpenAI.

## Rollout

Review-fix migration `20261021180000_trb_090_inbox_tombstones` (additive): `telegram_update.metadata_redacted_at` and the tombstone check. Existing rows are unchanged.

1. Apply the migration (`prisma migrate deploy`). It is additive and removes nothing.
2. Start with `RETENTION_CLEANUP=off`, the default, and review the matrix above.
3. Only with the owner's decision, set `RETENTION_CLEANUP=on`. The first passes catch up in batches. A backup taken before enabling it is the only way to recover purged content.

Cleanup was validated only on disposable test databases.

**Backups** (TRB-100, docs/OPERATIONS.md, section 11) are separate copies of the database. Cleanup never deletes content from existing backups; an older backup keeps content that was purged later. Backup retention and access are a separate owner decision.

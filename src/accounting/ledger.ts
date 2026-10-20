import type { Tx } from '../database/prisma-errors';
import type { Prisma } from '../generated/prisma/client';
import type { ProviderUsage } from '../research/provider/provider.types';
import { estimateRun, pricingHash, type ReservationPolicy } from './pricing';

/**
 * Reservation state machine and append-only ledger (TRB-050, docs/ACCOUNTING.md).
 *
 *   RESERVED --release-->  RELEASED   (no provider request can exist)
 *   RESERVED --settle--->  SETTLED    (terminal with usage)
 *   RESERVED --settle--->  UNRESOLVED (ambiguous outcome, usage missing or partial, model unmapped)
 *   SETTLED | UNRESOLVED --operator--> RESOLVED (confirmed amount from billing evidence)
 *
 * Every transition is conditional on the current status under the
 * reservation's row lock and writes ledger entries with unique operation keys,
 * so a replay changes nothing. Ledger amounts are changes of exposure and sum
 * to the reservation's exposure. Callers run these inside the transaction
 * that finalizes the run (fenced), so a stale worker cannot settle or release.
 */

type Entry = {
  kind: 'RESERVE' | 'RELEASE' | 'SETTLE' | 'UNRESOLVED' | 'OVERRUN' | 'RESOLVE';
  amount: bigint;
  key: string;
  basis: Record<string, unknown>;
};

interface ReservationRow {
  id: string;
  runId: string;
  userId: string;
  periodMonth: string;
  status: 'RESERVED' | 'RELEASED' | 'SETTLED' | 'UNRESOLVED' | 'RESOLVED';
  reservedMicros: bigint;
  exposureMicros: bigint;
  policy: Prisma.JsonValue;
}

const json = (value: Record<string, unknown>) =>
  JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    ),
  ) as Prisma.InputJsonValue;

async function writeEntries(tx: Tx, reservation: ReservationRow, entries: Entry[]): Promise<void> {
  let exposure = reservation.exposureMicros;
  for (const entry of entries) {
    exposure += entry.amount;
    await tx.usageLedger.create({
      data: {
        reservationId: reservation.id,
        runId: reservation.runId,
        userId: reservation.userId,
        periodMonth: reservation.periodMonth,
        kind: entry.kind,
        amountMicros: entry.amount,
        exposureAfterMicros: exposure,
        operationKey: entry.key,
        basis: json(entry.basis),
      },
    });
  }
}

async function lockReservation(tx: Tx, runId: string): Promise<ReservationRow | null> {
  await tx.$queryRaw`SELECT 1 AS locked FROM budget_reservation WHERE run_id = ${runId}::uuid FOR UPDATE`;
  return tx.budgetReservation.findUnique({
    where: { runId },
    select: {
      id: true,
      runId: true,
      userId: true,
      periodMonth: true,
      status: true,
      reservedMicros: true,
      exposureMicros: true,
      policy: true,
    },
  });
}

/**
 * Registers the pricing version on first use. Returns false when the label is
 * already registered with different content (rates changed without a new label).
 */
export async function registerPricing(tx: Tx, policy: ReservationPolicy): Promise<boolean> {
  const hash = pricingHash(policy.pricing);
  await tx.$executeRaw`
    INSERT INTO pricing_version (version, model, content, content_hash)
    VALUES (${policy.pricingVersion}, ${policy.pricing.model}, ${JSON.stringify(policy.pricing)}::jsonb, ${hash})
    ON CONFLICT (version) DO NOTHING`;
  const stored = await tx.pricingVersion.findUniqueOrThrow({
    where: { version: policy.pricingVersion },
    select: { contentHash: true },
  });
  return stored.contentHash === hash;
}

/** Current exposure of one UTC month, for one user or globally. */
export async function exposureMicros(tx: Tx, month: string, userId?: string): Promise<bigint> {
  const result = await tx.budgetReservation.aggregate({
    where: { periodMonth: month, ...(userId ? { userId } : {}) },
    _sum: { exposureMicros: true },
  });
  return result._sum.exposureMicros ?? 0n;
}

/** Admission: the reservation and its RESERVE entry (inside the admission transaction). */
export async function reserve(
  tx: Tx,
  input: { runId: string; userId: string; month: string; policy: ReservationPolicy },
): Promise<void> {
  const reserved = BigInt(input.policy.reservedMicros);
  const reservation = await tx.budgetReservation.create({
    data: {
      runId: input.runId,
      userId: input.userId,
      periodMonth: input.month,
      reservedMicros: reserved,
      exposureMicros: reserved,
      pricingVersion: input.policy.pricingVersion,
      policyVersion: input.policy.policyVersion,
      policy: json({ ...input.policy }),
    },
    select: {
      id: true,
      runId: true,
      userId: true,
      periodMonth: true,
      status: true,
      reservedMicros: true,
      exposureMicros: true,
      policy: true,
    },
  });
  await writeEntries(tx, { ...reservation, exposureMicros: 0n }, [
    {
      kind: 'RESERVE',
      amount: reserved,
      key: `reserve:${reservation.id}`,
      basis: { ...input.policy },
    },
  ]);
}

async function move(
  tx: Tx,
  reservation: ReservationRow,
  next: {
    status: ReservationRow['status'];
    exposure: bigint;
    estimated?: bigint | null;
    uncertain?: bigint | null;
    confirmed?: bigint | null;
  },
  entries: Entry[],
): Promise<boolean> {
  const updated = await tx.budgetReservation.updateMany({
    where: { id: reservation.id, status: reservation.status },
    data: {
      status: next.status,
      exposureMicros: next.exposure,
      ...(next.estimated !== undefined ? { estimatedMicros: next.estimated } : {}),
      ...(next.uncertain !== undefined ? { uncertainMicros: next.uncertain } : {}),
      ...(next.confirmed !== undefined ? { confirmedMicros: next.confirmed } : {}),
    },
  });
  if (updated.count !== 1) return false;
  await writeEntries(tx, reservation, entries);
  return true;
}

export type RunAccounting =
  /** No provider request can exist (cancelled before submission, rejected by the provider). */
  | { outcome: 'release'; reason: string }
  /** Terminal provider response: estimate from usage where possible. */
  | {
      outcome: 'settle';
      reason: string;
      usage: ProviderUsage | null;
      returnedModel: string | null;
      observedSearchItems: number;
    }
  /** Ambiguous: the request may still run or bill. */
  | {
      outcome: 'unresolved';
      reason: string;
      usage: ProviderUsage | null;
      returnedModel: string | null;
      observedSearchItems: number;
    };

export type SettlementResult =
  'NO_RESERVATION' | 'ALREADY_FINAL' | 'RELEASED' | 'SETTLED' | 'UNRESOLVED';

/**
 * Finalizes a run's reservation once. A second call (replay, recovery) finds
 * the reservation no longer RESERVED and changes nothing.
 */
export async function settleRun(
  tx: Tx,
  runId: string,
  accounting: RunAccounting,
): Promise<SettlementResult> {
  const reservation = await lockReservation(tx, runId);
  if (!reservation) return 'NO_RESERVATION';
  if (reservation.status !== 'RESERVED') return 'ALREADY_FINAL';
  const reserved = reservation.reservedMicros;
  if (accounting.outcome === 'release') {
    return (await move(tx, reservation, { status: 'RELEASED', exposure: 0n }, [
      {
        kind: 'RELEASE',
        amount: -reserved,
        key: `release:${reservation.id}`,
        basis: { reason: accounting.reason },
      },
    ]))
      ? 'RELEASED'
      : 'ALREADY_FINAL';
  }

  const policy = reservation.policy as unknown as ReservationPolicy;
  const estimate = estimateRun(policy, accounting);

  if (accounting.outcome === 'settle' && estimate.kind === 'estimate') {
    const known = estimate.estimatedMicros + estimate.uncertainMicros;
    const entries: Entry[] = [
      {
        kind: 'SETTLE',
        amount: (known < reserved ? known : reserved) - reserved,
        key: `settle:${reservation.id}`,
        basis: {
          reason: accounting.reason,
          ...estimate.basis,
          estimatedMicros: estimate.estimatedMicros,
          uncertainMicros: estimate.uncertainMicros,
        },
      },
    ];
    // An estimate above the reservation is recorded in full, never clamped.
    if (known > reserved) {
      entries.push({
        kind: 'OVERRUN',
        amount: known - reserved,
        key: `overrun:${reservation.id}`,
        basis: { reservedMicros: reserved, exposureMicros: known },
      });
    }
    return (await move(
      tx,
      reservation,
      {
        status: 'SETTLED',
        exposure: known,
        estimated: estimate.estimatedMicros,
        uncertain: estimate.uncertainMicros,
      },
      entries,
    ))
      ? 'SETTLED'
      : 'ALREADY_FINAL';
  }

  // Cost not fully known. Component policy (docs/ACCOUNTING.md): reported
  // components are priced, each unreported one keeps its own allowance, the
  // uncovered search allowance stays held; overall at least the reservation.
  // An amount above the reservation raises the exposure (recorded as an
  // overrun), never clamped. Nothing can be priced for missing usage or an
  // unmapped model: the reservation stays held.
  const known =
    estimate.kind === 'estimate'
      ? estimate.estimatedMicros
      : estimate.kind === 'partial'
        ? estimate.knownMicros
        : null;
  const held =
    estimate.kind === 'estimate'
      ? estimate.uncertainMicros
      : estimate.kind === 'partial'
        ? estimate.heldMicros
        : 0n;
  const componentTotal = known === null ? null : known + held;
  const exposure = componentTotal !== null && componentTotal > reserved ? componentTotal : reserved;
  const entries: Entry[] = [
    {
      kind: 'UNRESOLVED',
      amount: 0n,
      key: `unresolved:${reservation.id}`,
      basis: {
        reason: accounting.reason,
        unknownBecause:
          accounting.outcome === 'unresolved'
            ? 'OUTCOME_AMBIGUOUS'
            : estimate.kind === 'unknown'
              ? estimate.reason
              : 'USAGE_PARTIAL',
        ...estimate.basis,
        ...(estimate.kind === 'partial' ? { unknownComponents: estimate.unknownComponents } : {}),
        knownMicros: known,
        heldMicros: known === null ? null : held,
        exposureMicros: exposure,
      },
    },
  ];
  if (exposure > reserved) {
    entries.push({
      kind: 'OVERRUN',
      amount: exposure - reserved,
      key: `overrun:${reservation.id}`,
      basis: { reservedMicros: reserved, exposureMicros: exposure },
    });
  }
  return (await move(
    tx,
    reservation,
    {
      status: 'UNRESOLVED',
      exposure,
      // The known part, and the remainder of the exposure (held allowances, or the
      // reservation itself while nothing is known); together they equal the exposure.
      estimated: known,
      uncertain: known === null ? null : exposure - known,
    },
    entries,
  ))
    ? 'UNRESOLVED'
    : 'ALREADY_FINAL';
}

export class AccountingResolutionError extends Error {
  constructor(readonly code: string) {
    super(`Accounting resolution refused: ${code}`);
    this.name = 'AccountingResolutionError';
  }
}

/**
 * Operator resolution with an explicit confirmed amount (which may be 0 only
 * when the operator states it). Allowed once, for SETTLED or UNRESOLVED
 * reservations of finished runs. It does not change the run or its research
 * reconciliation.
 */
export async function resolveRun(
  tx: Tx,
  input: { runId: string; confirmedMicros: bigint; operator: string; note: string },
): Promise<{ previousExposureMicros: bigint; exposureMicros: bigint }> {
  if (input.confirmedMicros < 0n) throw new AccountingResolutionError('NEGATIVE_AMOUNT');
  if (!input.operator.trim() || !input.note.trim())
    throw new AccountingResolutionError('OPERATOR_AND_NOTE_REQUIRED');
  const reservation = await lockReservation(tx, input.runId);
  if (!reservation) throw new AccountingResolutionError('NO_RESERVATION');
  if (reservation.status !== 'SETTLED' && reservation.status !== 'UNRESOLVED') {
    throw new AccountingResolutionError(`NOT_RESOLVABLE_${reservation.status}`);
  }
  const run = await tx.researchRun.findUniqueOrThrow({
    where: { id: input.runId },
    select: { state: true },
  });
  if (run.state === 'QUEUED' || run.state === 'RUNNING')
    throw new AccountingResolutionError('RUN_NOT_FINISHED');
  const moved = await move(
    tx,
    reservation,
    { status: 'RESOLVED', exposure: input.confirmedMicros, confirmed: input.confirmedMicros },
    [
      {
        kind: 'RESOLVE',
        amount: input.confirmedMicros - reservation.exposureMicros,
        key: `resolve:${reservation.id}`,
        basis: {
          operator: input.operator.trim(),
          note: input.note.trim(),
          previousStatus: reservation.status,
          previousExposureMicros: reservation.exposureMicros,
          confirmedMicros: input.confirmedMicros,
        },
      },
    ],
  );
  if (!moved) throw new AccountingResolutionError('ALREADY_RESOLVED');
  return {
    previousExposureMicros: reservation.exposureMicros,
    exposureMicros: input.confirmedMicros,
  };
}

export interface UsageTotals {
  reservedMicros: bigint;
  estimatedMicros: bigint;
  unresolvedMicros: bigint;
  confirmedMicros: bigint;
  exposureMicros: bigint;
}

/** Totals of one UTC month by category (one user, or globally). */
export async function usageTotals(tx: Tx, month: string, userId?: string): Promise<UsageTotals> {
  const rows = await tx.budgetReservation.findMany({
    where: { periodMonth: month, ...(userId ? { userId } : {}) },
    select: {
      status: true,
      exposureMicros: true,
      estimatedMicros: true,
      uncertainMicros: true,
      confirmedMicros: true,
    },
  });
  const totals: UsageTotals = {
    reservedMicros: 0n,
    estimatedMicros: 0n,
    unresolvedMicros: 0n,
    confirmedMicros: 0n,
    exposureMicros: 0n,
  };
  for (const row of rows) {
    totals.exposureMicros += row.exposureMicros;
    if (row.status === 'RESERVED') totals.reservedMicros += row.exposureMicros;
    if (row.status === 'SETTLED') {
      totals.estimatedMicros += row.estimatedMicros ?? 0n;
      totals.unresolvedMicros += row.uncertainMicros ?? 0n;
    }
    if (row.status === 'UNRESOLVED') {
      // A known partial estimate is shown as estimated; the rest of the exposure is unresolved.
      totals.estimatedMicros += row.estimatedMicros ?? 0n;
      totals.unresolvedMicros +=
        row.estimatedMicros === null ? row.exposureMicros : (row.uncertainMicros ?? 0n);
    }
    if (row.status === 'RESOLVED') totals.confirmedMicros += row.confirmedMicros ?? 0n;
  }
  return totals;
}

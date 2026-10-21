import { describe, expect, it } from 'vitest';
import { parseEnv } from '../config/env.schema';
import {
  adminAccessCallbackData,
  adminUserCallbackData,
  adminUsersCallbackData,
  parseCallbackData,
} from '../telegram/callback-data';
import { sumComponents } from './ledger';
import { effectiveLimits, type LimitOverrides } from './limits';

const none: LimitOverrides = {
  limitSavedTasks: null,
  limitActiveTasks: null,
  limitDailyRuns: null,
  limitDailyManualRuns: null,
  limitActiveRuns: null,
  limitMonthlyBudgetMicros: null,
};
const config = parseEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db' });

describe('effectiveLimits (TRB-090)', () => {
  it('uses the environment defaults without overrides', () => {
    expect(effectiveLimits(none, config)).toMatchObject({
      savedTasks: 20,
      activeTasks: 5,
      dailyRuns: 10,
      dailyManualRuns: 5,
      activeRuns: 1,
      monthlyBudgetMicros: undefined,
    });
    expect([...effectiveLimits(none, config).overridden]).toEqual([]);
  });

  it('applies each override, including 0, and reports which ones apply', () => {
    const limits = effectiveLimits(
      { ...none, limitDailyRuns: 0, limitMonthlyBudgetMicros: 2_500_000n, limitActiveTasks: 7 },
      parseEnv({
        DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
        USER_MONTHLY_BUDGET_USD: '10',
      }),
    );
    expect(limits).toMatchObject({ dailyRuns: 0, activeTasks: 7, monthlyBudgetMicros: 2_500_000n });
    expect([...limits.overridden].sort()).toEqual(['activeTasks', 'dailyRuns', 'monthlyBudget']);
  });

  it('never turns a missing budget into a number', () => {
    expect(effectiveLimits(null, config).monthlyBudgetMicros).toBeUndefined();
  });
});

describe('sumComponents (one cost definition)', () => {
  it('keeps a partial estimate of an unresolved reservation as estimated', () => {
    const totals = sumComponents([
      {
        status: 'UNRESOLVED',
        exposureMicros: 284_000n,
        estimatedMicros: 2_400n,
        uncertainMicros: 281_600n,
        confirmedMicros: null,
      },
      {
        status: 'UNRESOLVED',
        exposureMicros: 284_000n,
        estimatedMicros: null,
        uncertainMicros: null,
        confirmedMicros: null,
      },
      {
        status: 'SETTLED',
        exposureMicros: 52_400n,
        estimatedMicros: 2_400n,
        uncertainMicros: 50_000n,
        confirmedMicros: null,
      },
      {
        status: 'RESERVED',
        exposureMicros: 284_000n,
        estimatedMicros: null,
        uncertainMicros: null,
        confirmedMicros: null,
      },
      {
        status: 'RESOLVED',
        exposureMicros: 30_000n,
        estimatedMicros: 2_400n,
        uncertainMicros: 0n,
        confirmedMicros: 30_000n,
      },
      {
        status: 'RELEASED',
        exposureMicros: 0n,
        estimatedMicros: null,
        uncertainMicros: null,
        confirmedMicros: null,
      },
    ]);
    expect(totals).toEqual({
      estimatedMicros: 4_800n,
      unresolvedMicros: 281_600n + 284_000n + 50_000n,
      reservedMicros: 284_000n,
      confirmedMicros: 30_000n,
      exposureMicros: 284_000n * 3n + 52_400n + 30_000n,
    });
  });
});

describe('administrator callbacks', () => {
  const user = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
  it('fit in 64 bytes and round-trip', () => {
    for (const data of [
      adminUsersCallbackData(42),
      adminUserCallbackData(user),
      adminAccessCallbackData(user, 999_999_999, 'reactivate'),
    ]) {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(parseCallbackData(data)).not.toBeNull();
    }
    expect(parseCallbackData(adminAccessCallbackData(user, 3, 'suspend'))).toEqual({
      kind: 'admin_access',
      userId: user,
      revision: 3,
      op: 'suspend',
    });
    for (const bad of [
      'au:-1',
      'au:x',
      'av:short',
      'ax:AAAAAAAAAAAAAAAAAAAAAA:1:z',
      'ax:!!!:1:s',
    ]) {
      expect(parseCallbackData(bad), bad).toBeNull();
    }
  });
});

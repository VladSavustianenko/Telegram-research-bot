import type { Env } from '../config/env.schema';

/**
 * Effective per-user limits (TRB-090, docs/ADMINISTRATION.md).
 *
 * Resolution, for every limit below: the user's persisted override when set,
 * otherwise the environment default. Global and system constraints are never
 * overridable per user: the global monthly budget, the queue limit, research
 * concurrency, model, pricing, provider request bounds, and the requirement
 * that live accounting is fully configured (missing environment budgets still
 * refuse live research; an override never turns a missing budget into
 * unlimited or free access).
 *
 * Every path reads limits through this function with the user row it holds
 * under the established lock order (identity lock, user row): task creation
 * and resume, /research, Run now, scheduled admission, retry authorization,
 * /usage and the administrator views. A limit change takes the same user row
 * lock, so it is serialized with admission.
 */
export interface LimitOverrides {
  limitSavedTasks: number | null;
  limitActiveTasks: number | null;
  limitDailyRuns: number | null;
  limitDailyManualRuns: number | null;
  limitActiveRuns: number | null;
  limitMonthlyBudgetMicros: bigint | null;
}

export type LimitName =
  'savedTasks' | 'activeTasks' | 'dailyRuns' | 'dailyManualRuns' | 'activeRuns' | 'monthlyBudget';

export interface EffectiveLimits {
  savedTasks: number;
  activeTasks: number;
  dailyRuns: number;
  dailyManualRuns: number;
  activeRuns: number;
  /** Undefined: no budget configured, so live research is refused (fail closed). */
  monthlyBudgetMicros: bigint | undefined;
  /** Which limits come from a per-user override. */
  overridden: ReadonlySet<LimitName>;
}

/** Limit names accepted by `/admin limit`, with their override column and bounds. */
export const LIMIT_SPECS: Record<
  string,
  { name: LimitName; column: keyof LimitOverrides; max: number; money?: true; label: string }
> = {
  tasks: { name: 'savedTasks', column: 'limitSavedTasks', max: 1000, label: 'збережені завдання' },
  active_tasks: {
    name: 'activeTasks',
    column: 'limitActiveTasks',
    max: 1000,
    label: 'активні завдання',
  },
  daily_runs: {
    name: 'dailyRuns',
    column: 'limitDailyRuns',
    max: 1000,
    label: 'досліджень за добу (усі)',
  },
  manual_runs: {
    name: 'dailyManualRuns',
    column: 'limitDailyManualRuns',
    max: 1000,
    label: 'ручних досліджень за добу',
  },
  active_runs: {
    name: 'activeRuns',
    column: 'limitActiveRuns',
    max: 100,
    label: 'одночасних досліджень',
  },
  budget_usd: {
    name: 'monthlyBudget',
    column: 'limitMonthlyBudgetMicros',
    max: Number.MAX_SAFE_INTEGER,
    money: true,
    label: 'місячний бюджет, USD',
  },
};

export function effectiveLimits(user: LimitOverrides | null, config: Env): EffectiveLimits {
  const overridden = new Set<LimitName>();
  const pick = <T>(name: LimitName, override: T | null | undefined, fallback: T): T => {
    if (override === null || override === undefined) return fallback;
    overridden.add(name);
    return override;
  };
  return {
    savedTasks: pick('savedTasks', user?.limitSavedTasks, config.TASK_SAVED_LIMIT),
    activeTasks: pick('activeTasks', user?.limitActiveTasks, config.TASK_ACTIVE_LIMIT),
    dailyRuns: pick('dailyRuns', user?.limitDailyRuns, config.USER_DAILY_RUN_LIMIT),
    dailyManualRuns: pick(
      'dailyManualRuns',
      user?.limitDailyManualRuns,
      config.USER_DAILY_MANUAL_RUN_LIMIT,
    ),
    activeRuns: pick('activeRuns', user?.limitActiveRuns, config.USER_ACTIVE_RUN_LIMIT),
    monthlyBudgetMicros: pick<bigint | undefined>(
      'monthlyBudget',
      user?.limitMonthlyBudgetMicros,
      config.USER_MONTHLY_BUDGET_USD,
    ),
    overridden,
  };
}

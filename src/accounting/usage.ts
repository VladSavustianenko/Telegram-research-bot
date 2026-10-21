import type { Env } from '../config/env.schema';
import type { Tx } from '../database/prisma-errors';
import { createStatusDelivery } from '../delivery/delivery-records';
import { denialMessage } from '../delivery/messages';
import type { AppUser } from '../generated/prisma/client';
import { isAdministrator, userOperationDenial } from '../identity/authorization';
import { usageTotals } from './ledger';
import { effectiveLimits } from './limits';
import { formatUsd, periodsOf } from './pricing';

/**
 * `/usage`: the sender's own quotas and accounting for the current UTC day and
 * month. Amounts are the application's estimates and reservations, never a
 * provider invoice; unused reservation is not spendable provider credit.
 */
export async function showUsage(
  tx: Tx,
  config: Env,
  input: { user: AppUser; chatId: bigint; now: Date },
): Promise<{ disposition: 'REPLIED' | 'REJECTED'; reason: string }> {
  const { user, chatId } = input;
  const denial = userOperationDenial(user, config);
  if (denial) {
    await createStatusDelivery(tx, chatId, denialMessage(denial));
    return { disposition: 'REJECTED', reason: denial };
  }
  const { day, month } = periodsOf(input.now);
  const limits = effectiveLimits(user, config);
  const counted = {
    userId: user.id,
    admittedDay: day,
    NOT: { state: 'CANCELLED' as const, submissionState: 'NOT_SUBMITTED' as const },
  };
  const [today, manualToday, active, reservations] = await Promise.all([
    tx.researchRun.count({ where: counted }),
    tx.researchRun.count({ where: { ...counted, trigger: 'MANUAL' } }),
    tx.researchRun.count({ where: { userId: user.id, state: { in: ['QUEUED', 'RUNNING'] } } }),
    tx.budgetReservation.count({ where: { userId: user.id, periodMonth: month } }),
  ]);
  const lines = [
    `Облік за UTC: доба ${day}, місяць ${month}.`,
    `Досліджень сьогодні: ${today} з ${limits.dailyRuns} (ручних: ${manualToday} з ${limits.dailyManualRuns}; ручний ліміт не стосується запусків за розкладом).`,
    `Активних зараз: ${active} з ${limits.activeRuns}.`,
    'Скасовані до звернення до провайдера запуски не враховуються.',
  ];
  if (config.RESEARCH_MODE === 'live' || reservations > 0) {
    const totals = await usageTotals(tx, month, user.id);
    const budget =
      config.USER_MONTHLY_BUDGET_USD === undefined ? undefined : limits.monthlyBudgetMicros;
    lines.push(
      '',
      `Live-витрати за ${month} (оцінки застосунку, не рахунок OpenAI):`,
      `- оцінено за звітами провайдера: ${formatUsd(totals.estimatedMicros)}`,
      `- зарезервовано для поточних запусків: ${formatUsd(totals.reservedMicros)}`,
      `- невизначено (непідтверджені пошуки, невідомі витрати): ${formatUsd(totals.unresolvedMicros)}`,
      `- підтверджено оператором: ${formatUsd(totals.confirmedMicros)}`,
      budget === undefined
        ? `Разом враховано: ${formatUsd(totals.exposureMicros)}. Місячний бюджет не налаштовано: нові live-запуски недоступні.`
        : `Разом враховано: ${formatUsd(totals.exposureMicros)} з бюджету ${formatUsd(budget)}; ` +
            `доступно для нових резервів: ${formatUsd(budget > totals.exposureMicros ? budget - totals.exposureMicros : 0n)}.`,
      'Резерв — це запас обліку застосунку, а не гарантований кредит у OpenAI; фактичний рахунок може відрізнятися.',
    );
    if (!isAdministrator(user, config))
      lines.push('Live-дослідження поки доступні лише адміністраторам.');
  } else if (config.RESEARCH_MODE === 'fake') {
    lines.push('', 'Режим симуляції: реальних витрат немає.');
  }
  await createStatusDelivery(tx, chatId, lines.join('\n'));
  return { disposition: 'REPLIED', reason: 'USAGE' };
}

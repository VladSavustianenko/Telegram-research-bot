import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { AccountingResolutionError, correctResolution, resolveRun } from '../accounting/ledger';
import { formatUsd } from '../accounting/pricing';
import { ConfigValidationError, parseUsdMicros } from '../config/env.schema';
import { loadConfig } from '../config/load-config';
import { PrismaService } from '../database/prisma.service';

/**
 * Operator command for financial resolution of live runs (docs/ACCOUNTING.md).
 *   node dist/ops/accounting.js --list
 *   node dist/ops/accounting.js --run <id> --confirmed-usd <amount> --operator <name> --note <text>
 *   node dist/ops/accounting.js --correct --run <id> --confirmed-usd <amount> --operator <name> --note <text>
 * --correct (TRB-090) changes an already RESOLVED amount with an appended CORRECT entry.
 * Records an amount confirmed from billing evidence (once, append-only ledger).
 * Never contacts OpenAI or Telegram; never changes the run or its research
 * reconciliation. "0" must be stated explicitly.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      list: { type: 'boolean' },
      correct: { type: 'boolean' },
      run: { type: 'string' },
      'confirmed-usd': { type: 'string' },
      operator: { type: 'string' },
      note: { type: 'string' },
    },
  });
  const prisma = new PrismaService(loadConfig());
  try {
    if (values.list) {
      const open = await prisma.budgetReservation.findMany({
        where: {
          OR: [{ status: 'UNRESOLVED' }, { status: 'SETTLED', uncertainMicros: { gt: 0n } }],
        },
        orderBy: { createdAt: 'asc' },
        select: {
          runId: true,
          attemptNo: true,
          status: true,
          periodMonth: true,
          reservedMicros: true,
          estimatedMicros: true,
          uncertainMicros: true,
          exposureMicros: true,
          pricingVersion: true,
          run: {
            select: { state: true, failureCode: true, providerResponseId: true, submittedAt: true },
          },
        },
      });
      const rows = open.map((row) => ({
        ...row,
        reserved: formatUsd(row.reservedMicros),
        estimated: row.estimatedMicros === null ? null : formatUsd(row.estimatedMicros),
        uncertain: row.uncertainMicros === null ? null : formatUsd(row.uncertainMicros),
        exposure: formatUsd(row.exposureMicros),
      }));
      process.stdout.write(
        `${JSON.stringify(rows, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value), 2)}\n`,
      );
      return 0;
    }
    const amount = values['confirmed-usd'];
    if (!values.run || amount === undefined || !values.operator || !values.note) {
      process.stderr.write(
        'Usage: --list | [--correct] --run <id> --confirmed-usd <amount> --operator <name> --note <text>\n',
      );
      return 2;
    }
    const confirmedMicros = parseUsdMicros(amount);
    if (confirmedMicros === null) {
      process.stderr.write(
        '--confirmed-usd must be a non-negative USD amount with at most 6 decimals\n',
      );
      return 2;
    }
    const runId = values.run;
    const resolve = values.correct ? correctResolution : resolveRun;
    const result = await prisma.$transaction((tx) =>
      resolve(tx, {
        runId,
        confirmedMicros,
        operator: values.operator ?? '',
        note: values.note ?? '',
      }),
    );
    process.stdout.write(
      `${values.correct ? 'Corrected' : 'Resolved'} ${runId}: exposure ${formatUsd(result.previousExposureMicros)} -> ${formatUsd(result.exposureMicros)}\n`,
    );
    return 0;
  } finally {
    await prisma.onApplicationShutdown();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof AccountingResolutionError || error instanceof ConfigValidationError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`Failed: ${error instanceof Error ? error.name : 'unknown error'}\n`);
    process.exit(1);
  },
);

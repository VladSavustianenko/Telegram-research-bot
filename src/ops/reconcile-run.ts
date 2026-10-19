import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { ConfigValidationError } from '../config/env.schema';
import { loadConfig } from '../config/load-config';
import { PrismaService } from '../database/prisma.service';
import {
  RESOLUTIONS,
  ReconciliationError,
  listUnresolved,
  reconcileUncertainRun,
  type Resolution,
} from '../research/reconciliation';

/**
 * Operator command for UNCERTAIN research runs (docs/RESEARCH_SLICE.md).
 *   node dist/ops/reconcile-run.js --list
 *   node dist/ops/reconcile-run.js --run <id> --resolution <R> --operator <name> --note <text>
 * Never contacts OpenAI or Telegram and never resubmits research.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      list: { type: 'boolean' },
      run: { type: 'string' },
      resolution: { type: 'string' },
      operator: { type: 'string' },
      note: { type: 'string' },
    },
  });
  const prisma = new PrismaService(loadConfig());
  try {
    if (values.list) {
      const runs = await listUnresolved(prisma);
      process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`);
      return 0;
    }
    if (!values.run || !values.resolution || !values.operator || !values.note) {
      process.stderr.write(
        `Usage: --list | --run <id> --resolution <${RESOLUTIONS.join('|')}> --operator <name> --note <text>\n`,
      );
      return 2;
    }
    const result = await reconcileUncertainRun(prisma, {
      runId: values.run,
      resolution: values.resolution as Resolution,
      operator: values.operator,
      note: values.note,
    });
    process.stdout.write(`Reconciled ${result.runId} (audit record ${result.reconciliationId})\n`);
    return 0;
  } finally {
    await prisma.onApplicationShutdown();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof ReconciliationError || error instanceof ConfigValidationError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write(`Failed: ${error instanceof Error ? error.name : 'unknown error'}\n`);
    }
    process.exit(1);
  },
);

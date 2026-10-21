import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { ConfigValidationError } from '../config/env.schema';
import { loadConfig } from '../config/load-config';
import { PrismaService } from '../database/prisma.service';
import { clearHold, readHold, setHold } from '../operations/hold';

/**
 * Operator command for the durable execution hold (TRB-100, docs/OPERATIONS.md).
 *   node dist/ops/hold.js --status
 *   node dist/ops/hold.js --set --reason <text> --operator <name>
 *   node dist/ops/hold.js --clear --operator <name> --confirm
 * While set, application processes on this database start no ingress,
 * scheduler, dispatcher, worker, polling or retention (they report "held").
 * A running process notices a new hold only at its next start; clearing it
 * opens held processes within about 30 s. Never contacts OpenAI or Telegram.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      status: { type: 'boolean' },
      set: { type: 'boolean' },
      clear: { type: 'boolean' },
      confirm: { type: 'boolean' },
      reason: { type: 'string' },
      operator: { type: 'string' },
    },
  });
  const prisma = new PrismaService(loadConfig());
  try {
    if (values.status) {
      process.stdout.write(`${JSON.stringify({ hold: await readHold(prisma) }, null, 2)}\n`);
      return 0;
    }
    if (values.set) {
      const reason = values.reason?.trim() ?? '';
      const operator = values.operator?.trim() ?? '';
      if (!reason || reason.length > 500 || !operator || operator.length > 100) {
        process.stderr.write('Usage: --set --reason <1-500 chars> --operator <1-100 chars>\n');
        return 2;
      }
      const { created, hold } = await setHold(prisma, { reason, setBy: operator });
      process.stdout.write(
        `${created ? 'Hold set' : 'Hold already set (unchanged)'}: ${JSON.stringify(hold)}\n`,
      );
      return 0;
    }
    if (values.clear) {
      if (!values.confirm || !values.operator?.trim()) {
        process.stderr.write(
          'Clearing the hold lets every process on this database execute again.\n' +
            'Run it only after the restore checklist (docs/OPERATIONS.md). Usage: --clear --operator <name> --confirm\n',
        );
        return 2;
      }
      const existing = await readHold(prisma);
      const cleared = await clearHold(prisma);
      process.stdout.write(
        cleared
          ? `Hold cleared by ${values.operator.trim()} (was: ${JSON.stringify(existing)})\n`
          : 'No hold was set\n',
      );
      return 0;
    }
    process.stderr.write(
      'Usage: --status | --set --reason <text> --operator <name> | --clear --operator <name> --confirm\n',
    );
    return 2;
  } finally {
    await prisma.onApplicationShutdown();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof ConfigValidationError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write(`Failed: ${error instanceof Error ? error.name : 'unknown error'}\n`);
    }
    process.exit(1);
  },
);

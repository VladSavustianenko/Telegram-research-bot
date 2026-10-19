import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { ConfigValidationError } from '../config/env.schema';
import { loadConfig } from '../config/load-config';
import { PrismaService } from '../database/prisma.service';
import { summarizeToolTelemetry } from '../research/tool-telemetry';

/**
 * Read-only diagnostic: observed tool items of one research run.
 *   node dist/ops/tool-telemetry.js --run <id>
 * Reads the local database only; never contacts OpenAI or Telegram.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({ options: { run: { type: 'string' } } });
  if (!values.run || !/^[0-9a-f-]{36}$/i.test(values.run)) {
    process.stderr.write('Usage: --run <research run id>\n');
    return 2;
  }
  const prisma = new PrismaService(loadConfig());
  try {
    const summary = await summarizeToolTelemetry(prisma, values.run);
    if (!summary) {
      process.stderr.write('Run not found\n');
      return 1;
    }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  } finally {
    await prisma.onApplicationShutdown();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      error instanceof ConfigValidationError
        ? `${error.message}\n`
        : `Failed: ${error instanceof Error ? error.name : 'unknown error'}\n`,
    );
    process.exit(1);
  },
);

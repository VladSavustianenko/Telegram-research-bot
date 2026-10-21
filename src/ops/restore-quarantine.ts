import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { ConfigValidationError } from '../config/env.schema';
import { loadConfig } from '../config/load-config';
import { PrismaService } from '../database/prisma.service';
import {
  QuarantineError,
  applyQuarantine,
  listCandidates,
  previewQuarantine,
  type Target,
} from '../operations/restore-quarantine';

/**
 * Operator command for a restored database under the operational hold
 * (TRB-100, docs/OPERATIONS.md, section 11.3).
 *   node dist/ops/restore-quarantine.js --list
 *   node dist/ops/restore-quarantine.js --run <id> [--run <id>] [--delivery <id>]   (preview)
 *   node dist/ops/restore-quarantine.js --run <id> --delivery <id> \
 *       --operator <name> --reason <text> --confirm
 * Without --confirm nothing changes. With it, the hold must be set and no
 * process may hold a live lease; all selected records change in one
 * transaction with audit events; repeating it changes nothing. Never contacts
 * OpenAI or Telegram and never opens ingress or workers.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      list: { type: 'boolean' },
      run: { type: 'string', multiple: true },
      delivery: { type: 'string', multiple: true },
      operator: { type: 'string' },
      reason: { type: 'string' },
      confirm: { type: 'boolean' },
    },
  });
  const prisma = new PrismaService(loadConfig());
  const print = (value: unknown) =>
    process.stdout.write(
      `${JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`,
    );
  try {
    if (values.list) {
      print(await listCandidates(prisma));
      return 0;
    }
    const targets: Target[] = [
      ...(values.run ?? []).map((id) => ({ kind: 'run' as const, id })),
      ...(values.delivery ?? []).map((id) => ({ kind: 'delivery' as const, id })),
    ];
    if (targets.length === 0) {
      process.stderr.write(
        'Usage: --list | --run <id>... --delivery <id>... [--operator <name> --reason <text> --confirm]\n',
      );
      return 2;
    }
    if (!values.confirm) {
      print({ preview: true, plan: await previewQuarantine(prisma, targets) });
      process.stdout.write(
        'Nothing changed. Re-run with --operator <name> --reason <text> --confirm to apply.\n',
      );
      return 0;
    }
    if (!values.operator?.trim() || !values.reason?.trim()) {
      process.stderr.write('--confirm requires --operator <name> and --reason <text>\n');
      return 2;
    }
    const result = await applyQuarantine(prisma, {
      targets,
      operator: values.operator,
      reason: values.reason,
    });
    print({ applied: true, result });
    const runs = result.filter((item) => item.kind === 'run' && item.action === 'QUARANTINE');
    if (runs.length > 0) {
      process.stdout.write(
        'Next, per run: node dist/ops/reconcile-run.js --run <id> --resolution <R> --operator <name> --note <evidence>\n' +
          'and, for live runs: node dist/ops/accounting.js --run <id> --confirmed-usd <amount> --operator <name> --note <evidence>\n',
      );
    }
    return 0;
  } finally {
    await prisma.onApplicationShutdown();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof QuarantineError || error instanceof ConfigValidationError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      const code = (error as { code?: unknown }).code;
      process.stderr.write(
        `Failed: ${error instanceof Error ? error.name : 'unknown error'}${typeof code === 'string' ? ` (${code})` : ''}\n`,
      );
    }
    process.exit(1);
  },
);

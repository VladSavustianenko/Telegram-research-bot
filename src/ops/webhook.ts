import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { Api, GrammyError, HttpError } from 'grammy';
import { ConfigValidationError } from '../config/env.schema';
import { loadConfig } from '../config/load-config';

/**
 * Operator command for the Telegram webhook (TRB-100, docs/OPERATIONS.md).
 *   node dist/ops/webhook.js --info               getWebhookInfo (read-only)
 *   node dist/ops/webhook.js --set                prints what would be registered
 *   node dist/ops/webhook.js --set --confirm      setWebhook
 *   node dist/ops/webhook.js --delete --confirm   deleteWebhook (stops Telegram pushing)
 * Every call is an explicit operator action; nothing here runs on install,
 * build or start. Pending updates are always kept (drop_pending_updates=false;
 * there is no option to drop them). The bot token and the webhook secret are
 * never printed: Telegram errors are reduced to their code and description,
 * and network errors to their class (their messages can contain the URL).
 */

const WEBHOOK_PATH = '/telegram/webhook';
const ALLOWED_UPDATES = ['message', 'callback_query'] as const;

function webhookUrl(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}${WEBHOOK_PATH}`;
}

function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return 2;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      info: { type: 'boolean' },
      set: { type: 'boolean' },
      delete: { type: 'boolean' },
      confirm: { type: 'boolean' },
    },
  });
  const config = loadConfig();
  const token = config.TELEGRAM_BOT_TOKEN;
  if (!token) return fail('TELEGRAM_BOT_TOKEN is required');
  const api = new Api(token, {
    timeoutSeconds: 15,
    ...(config.TELEGRAM_API_ROOT ? { apiRoot: config.TELEGRAM_API_ROOT } : {}),
  });

  if (values.info) {
    const info = await api.getWebhookInfo();
    const expected = config.PUBLIC_BASE_URL ? webhookUrl(config.PUBLIC_BASE_URL) : null;
    const allowed = info.allowed_updates ?? [];
    process.stdout.write(
      `${JSON.stringify(
        {
          url: info.url,
          expectedUrl: expected,
          urlMatches: expected !== null && info.url === expected,
          allowedUpdates: info.allowed_updates ?? null,
          allowedUpdatesMatch: ALLOWED_UPDATES.every((kind) => allowed.includes(kind)),
          pendingUpdateCount: info.pending_update_count,
          lastErrorDate: info.last_error_date
            ? new Date(info.last_error_date * 1_000).toISOString()
            : null,
          lastErrorMessage: info.last_error_message ?? null,
          maxConnections: info.max_connections ?? null,
          note: 'Telegram does not return the secret; verify it by a 200 on the next real update.',
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (values.set) {
    if (config.TELEGRAM_MODE !== 'webhook') {
      return fail('Refusing: set TELEGRAM_MODE=webhook on the service first (no polling may run).');
    }
    const secret = config.TELEGRAM_WEBHOOK_SECRET;
    if (!secret) return fail('TELEGRAM_WEBHOOK_SECRET is required');
    if (!config.PUBLIC_BASE_URL?.startsWith('https://')) {
      return fail('PUBLIC_BASE_URL must be the public https:// base URL of the service');
    }
    const url = webhookUrl(config.PUBLIC_BASE_URL);
    const plan = { url, allowedUpdates: ALLOWED_UPDATES, dropPendingUpdates: false };
    if (!values.confirm) {
      process.stdout.write(
        `Would call setWebhook with the configured secret: ${JSON.stringify(plan)}\nRe-run with --confirm to register it.\n`,
      );
      return 0;
    }
    await api.setWebhook(url, {
      secret_token: secret,
      allowed_updates: [...ALLOWED_UPDATES],
      drop_pending_updates: false,
    });
    process.stdout.write(`setWebhook succeeded: ${JSON.stringify(plan)}\n`);
    return 0;
  }

  if (values.delete) {
    if (!values.confirm) {
      return fail(
        'deleteWebhook stops Telegram from pushing updates (they stay pending for up to 24 h).\n' +
          'Re-run with --delete --confirm.',
      );
    }
    await api.deleteWebhook({ drop_pending_updates: false });
    process.stdout.write('deleteWebhook succeeded (pending updates kept)\n');
    return 0;
  }

  return fail('Usage: --info | --set [--confirm] | --delete --confirm');
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof ConfigValidationError) {
      process.stderr.write(`${error.message}\n`);
    } else if (error instanceof GrammyError) {
      process.stderr.write(`Telegram refused: ${error.error_code} ${error.description}\n`);
    } else if (error instanceof HttpError) {
      process.stderr.write('Telegram request failed: network error (details withheld)\n');
    } else {
      process.stderr.write(`Failed: ${error instanceof Error ? error.name : 'unknown error'}\n`);
    }
    process.exit(1);
  },
);

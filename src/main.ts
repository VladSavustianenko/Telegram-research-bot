import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppLifecycle } from './common/lifecycle';
import { ConfigValidationError } from './config/env.schema';
import { loadConfig } from './config/load-config';
import { createLogger } from './logger';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  const app = await NestFactory.create(AppModule.forRoot(config), { logger });
  // Graceful shutdown (TRB-100, docs/OPERATIONS.md). Railway sends SIGTERM to the
  // old deployment and SIGKILL after its draining time. Order:
  // 1. every component stops taking new work at once (AppLifecycle);
  // 2. Nest hooks wait, bounded, for work in progress (workers, loops, polling);
  // 3. pg-boss stops, the HTTP server closes, the database pool drains last.
  // The process exits at the latest after SHUTDOWN_TIMEOUT_SECONDS.
  const lifecycle = app.get(AppLifecycle);
  const shutdown = (signal: NodeJS.Signals): void => {
    if (lifecycle.shuttingDown) return;
    const started = Date.now();
    logger.log({ message: 'Shutdown started', signal }, 'Bootstrap');
    lifecycle.beginShutdown();
    setTimeout(() => {
      logger.error(
        { message: 'Shutdown exceeded SHUTDOWN_TIMEOUT_SECONDS; exiting', signal },
        'Bootstrap',
      );
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_SECONDS * 1_000).unref();
    app.close().then(
      () => {
        logger.log({ message: 'Shutdown complete', ms: Date.now() - started }, 'Bootstrap');
        process.exit(0);
      },
      (error: unknown) => {
        logger.error(
          {
            message: 'Shutdown failed',
            errorName: error instanceof Error ? error.name : 'unknown',
          },
          'Bootstrap',
        );
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen(config.PORT, '0.0.0.0');
  logger.log(
    {
      message: 'Application started',
      port: config.PORT,
      env: config.NODE_ENV,
      telegramMode: config.TELEGRAM_MODE,
      researchMode: config.RESEARCH_MODE,
      backgroundWorkers: config.BACKGROUND_WORKERS,
      queueSchema: config.QUEUE_SCHEMA,
      shutdownTimeoutSeconds: config.SHUTDOWN_TIMEOUT_SECONDS,
    },
    'Bootstrap',
  );
  if (config.RESEARCH_MODE === 'live') {
    logger.warn(
      {
        message: 'LIVE research enabled: requests to OpenAI are billed',
        model: config.OPENAI_MODEL,
        outputTokenLimit: config.OUTPUT_TOKEN_LIMIT,
        toolCallLimit: config.TOOL_CALL_LIMIT,
        runDeadlineSeconds: config.RUN_DEADLINE_SECONDS,
      },
      'Bootstrap',
    );
  }
}

bootstrap().catch((error: unknown) => {
  if (error instanceof ConfigValidationError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(
      `Startup failed: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
  }
  process.exit(1);
});

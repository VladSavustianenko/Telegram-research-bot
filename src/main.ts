import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigValidationError } from './config/env.schema';
import { loadConfig } from './config/load-config';
import { createLogger } from './logger';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  const app = await NestFactory.create(AppModule.forRoot(config), { logger });
  // Graceful shutdown: Railway sends SIGTERM on deploy/stop.
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);

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

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
    { message: 'Application started', port: config.PORT, env: config.NODE_ENV },
    'Bootstrap',
  );
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

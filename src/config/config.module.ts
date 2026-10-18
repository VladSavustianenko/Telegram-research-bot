import { DynamicModule, Global, Module } from '@nestjs/common';
import { Env } from './env.schema';

export const APP_CONFIG = Symbol('APP_CONFIG');

/** Exposes the already-validated configuration. Validation happens before Nest boots. */
@Global()
@Module({})
export class AppConfigModule {
  static forRoot(config: Env): DynamicModule {
    return {
      module: AppConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: Object.freeze({ ...config }) }],
      exports: [APP_CONFIG],
    };
  }
}

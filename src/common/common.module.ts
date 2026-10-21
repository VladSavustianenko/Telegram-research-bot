import { Global, Module } from '@nestjs/common';
import { CLOCK, systemClock } from './clock';
import { AppLifecycle } from './lifecycle';

@Global()
@Module({
  providers: [{ provide: CLOCK, useValue: systemClock }, AppLifecycle],
  exports: [CLOCK, AppLifecycle],
})
export class CommonModule {}

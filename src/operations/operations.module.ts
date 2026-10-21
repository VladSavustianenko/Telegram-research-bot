import { Global, Module } from '@nestjs/common';
import { ExecutionGate, SHIPPED_MIGRATIONS } from './execution-gate';
import { shippedMigrations } from './schema-state';

/** Startup gate shared by every component that acts (TRB-100). */
@Global()
@Module({
  providers: [ExecutionGate, { provide: SHIPPED_MIGRATIONS, useValue: () => shippedMigrations() }],
  exports: [ExecutionGate],
})
export class OperationsModule {}

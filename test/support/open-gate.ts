import type { ExecutionGate, GateState } from '../../src/operations/execution-gate';

/** Execution gate stand-in for unit tests that do not exercise it (no database query). */
export function openGate(state: GateState = 'open'): Pick<
  ExecutionGate,
  'state' | 'open' | 'whenOpen'
> & {
  onApplicationBootstrap(): Promise<void>;
  onModuleDestroy(): Promise<void>;
} {
  return {
    state,
    open: state === 'open',
    whenOpen: (callback) => {
      if (state === 'open') void callback();
    },
    onApplicationBootstrap: () => Promise.resolve(),
    onModuleDestroy: () => Promise.resolve(),
  };
}

/**
 * Conformance harness registry.
 *
 * `conformance.test.ts` states that "an out-of-tree driver adds its own harness
 * and must pass every case unchanged" — this is the mechanism that makes that
 * true. Without it the harness list is a literal in the suite, and an overlay
 * driver has no way to be measured by the floor it is supposed to meet except
 * by copying 700 lines of cases, which then rot independently.
 *
 * Its own module, not part of the barrel, for the reason `driver-registry.ts`
 * spells out: the file an overlay appends an import to must not be the file
 * that owns the map, or the appended import evaluates while the map is still
 * in its temporal dead zone.
 *
 * The types here are structural duplicates of the suite's local ones on
 * purpose. Exporting them from the test file would make a test module part of
 * the seam's public surface; structural assignability gets the same checking
 * with no such coupling.
 */
import type { FakeCli } from './fake-cli.js';
import type { SessionEventsDriver } from './session-events.js';
import type { SessionKey, SessionSpec } from './types.js';

/** What a driver realized, in vocabulary no runtime owns. */
export interface ConformanceRealized {
  containers: Array<{
    role: string;
    image: string;
    env: Record<string, string>;
    mounts: Array<{ hostPath: string; containerPath: string; ro: boolean }>;
  }>;
  labels: Record<string, string>;
}

export interface ConformanceHarness {
  name: string;
  driver: SessionEventsDriver;
  cli: FakeCli;
  realize(spec: SessionSpec): Promise<ConformanceRealized>;
  /** Make the next realization fail with a runtime message of the given shape. */
  failWith(message: string): void;
  /**
   * A message THIS runtime emits when it cannot be reached. The floor asserts
   * the mapping to `runtime-unavailable`; the wording is dialect, and a literal
   * from one runtime in a shared case only ever tested that one.
   */
  unreachableMessage: string;
  /** Script the CLI so a lookup for the fixture's key reports a live session. */
  scriptExistingSession(key: SessionKey): void;
  /** Script the CLI so a listing reports exactly these sessions. */
  scriptSessions(rows: readonly ConformanceListRow[]): void;
}

/** One row of a scripted listing, in vocabulary no runtime owns. */
export interface ConformanceListRow {
  name: string;
  agentGroupId: string;
  sessionId: string;
  /** Neutral lifecycle words the floor asserts phases against. */
  state: 'running' | 'exited' | 'created';
}

export type ConformanceHarnessFactory = () => ConformanceHarness;

const registry: ConformanceHarnessFactory[] = [];

/**
 * Add a harness to the floor. Called at module scope from a file reached via
 * `conformance-installed.ts`. Every registered harness runs every case; a
 * driver that cannot pass one does not get to register a narrower suite.
 */
export function registerConformanceHarness(factory: ConformanceHarnessFactory): void {
  registry.push(factory);
}

/** Fresh harnesses for one test, built per `beforeEach` like the built-in one. */
export function extraHarnesses(): ConformanceHarness[] {
  return registry.map((factory) => factory());
}

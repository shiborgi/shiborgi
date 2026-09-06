/**
 * Puts the Apple Container driver on the shared conformance floor.
 *
 * The realization is read back from the argv the driver actually emitted, in
 * the same runtime-neutral vocabulary the Docker harness reports — which is
 * what makes an assertion in `conformance.test.ts` mean the same thing for
 * both. The parsing is identical because the mount, env and label dialects
 * are: this driver reuses `mountArgs`/`envArgs`/`labelArgs` from the Docker
 * realization rather than restating them.
 */
import { AppleContainerSessionDriver } from './apple-container-driver.js';
import {
  registerConformanceHarness,
  type ConformanceHarness,
  type ConformanceListRow,
  type ConformanceRealized,
} from './conformance-harness-registry.js';
import { FakeCli } from './fake-cli.js';
import { withSessionEvents } from './session-events.js';
import { FIXTURE_POLICY } from './spec-fixture.js';
import { LABELS } from './types.js';

/** How the live CLI answers `inspect` for a container that does not exist. */
const NO_SUCH_CONTAINER = /^inspect /;

function appleContainerHarness(): ConformanceHarness {
  const cli = new FakeCli('container');
  cli.responses = [{ match: NO_SUCH_CONTAINER, throws: new Error('Error: no such container') }];
  // Wrapped exactly as `createSessionDriver` wraps it in production: the
  // conformance surface is the seam consumers see, and `onTerminal` lives in
  // the session-events hub, not in any driver.
  const driver = withSessionEvents(new AppleContainerSessionDriver({ ...FIXTURE_POLICY, cli }));
  return {
    name: 'apple-container',
    driver,
    cli,
    async realize(spec) {
      await driver.prepare(spec);
      const create = cli.callMatching(/^create /)!.args;
      const env: Record<string, string> = {};
      const mounts: ConformanceRealized['containers'][number]['mounts'] = [];
      const labels: Record<string, string> = {};
      for (let i = 0; i < create.length; i++) {
        if (create[i] === '-e') {
          const eq = create[i + 1].indexOf('=');
          env[create[i + 1].slice(0, eq)] = create[i + 1].slice(eq + 1);
        }
        if (create[i] === '-v') {
          const parts = create[i + 1].split(':');
          mounts.push({ hostPath: parts[0], containerPath: parts[1], ro: parts[2] === 'ro' });
        }
        if (create[i] === '--label') {
          const eq = create[i + 1].indexOf('=');
          labels[create[i + 1].slice(0, eq)] = create[i + 1].slice(eq + 1);
        }
      }
      const agent = spec.containers.find((c) => c.role === 'agent')!;
      return { containers: [{ role: 'agent', image: agent.image, env, mounts }], labels };
    },
    failWith(message) {
      cli.responses = [
        { match: NO_SUCH_CONTAINER, throws: new Error('Error: no such container') },
        { match: /^create /, throws: new Error(message) },
      ];
    },
    // What the runtime actually says when its apiserver is down.
    unreachableMessage: 'Ensure container system service has been started',
    scriptExistingSession(key) {
      cli.responses = [
        {
          match: NO_SUCH_CONTAINER,
          output: appleDocument([
            {
              name: `ncl-${key.installSlug}-${key.sessionId}`,
              agentGroupId: key.agentGroupId,
              sessionId: key.sessionId,
              state: 'running',
            },
          ]),
        },
      ];
    },
    scriptSessions(rows) {
      cli.responses = [{ match: /^list /, output: appleDocument(rows) }];
    },
  };
}

/**
 * The neutral rows as this runtime reports them: labels under `configuration`,
 * lifecycle under `status.state`. 'exited' is spelled 'stopped' here — the
 * dialect difference the floor must not have to know about.
 */
function appleDocument(rows: readonly ConformanceListRow[]): string {
  return JSON.stringify(
    rows.map((row) => ({
      configuration: {
        id: row.name,
        labels: {
          [LABELS.install]: 'spike',
          [LABELS.role]: 'agent',
          [LABELS.group]: row.agentGroupId,
          [LABELS.session]: row.sessionId,
        },
      },
      status: { state: row.state === 'exited' ? 'stopped' : row.state },
    })),
  );
}

registerConformanceHarness(appleContainerHarness);

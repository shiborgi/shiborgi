/**
 * The Apple Container egress topology: one host-only network per install.
 *
 * Agent sessions run on a `hostOnly` network, which has no route off the host.
 * The only thing reachable from it is the host itself, at the network's own
 * gateway address — and that is where the gateway container publishes its
 * ports. So "the agent talks to the gateway and nothing else" is enforced by
 * the runtime's routing, not by a firewall inside the guest that the guest
 * could in principle undo.
 *
 * The network name is install-scoped by default, for the same reason image
 * tags and service units already are (`install-slug.ts`): the `container`
 * runtime is a machine-wide namespace, and two clones of this project are
 * meant to run side by side — a bar assistant and a personal one — without
 * either being able to reach the other's gateway. A fixed shared name would
 * silently put them on one network.
 *
 * `NANOCLAW_EGRESS_NETWORK` overrides the derivation for deployments that
 * manage the network out of band. Overriding it to the same value in two
 * installs is what joining them deliberately looks like.
 */
import { getInstallSlug } from './install-slug.js';

import { readEnvFile } from './env.js';
import { log } from './log.js';

import { realCli, validateRuntimeName, type Cli } from './drivers/cli.js';

/** Raised when the egress topology cannot be established. Never spawn with open egress. */
export class AppleEgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppleEgressError';
  }
}

/**
 * `process.env` wins, then `.env`, then the install-scoped derivation — the
 * precedence every other NanoClaw setting uses. The host service has no
 * `EnvironmentFile=`; it parses `.env` in-process, so consulting only
 * `process.env` would silently ignore the file where operators put settings.
 */
export function egressNetworkName(env: NodeJS.ProcessEnv = process.env, projectRoot?: string): string {
  const configured =
    env.NANOCLAW_EGRESS_NETWORK?.trim() ||
    readEnvFile(['NANOCLAW_EGRESS_NETWORK'], projectRoot).NANOCLAW_EGRESS_NETWORK?.trim() ||
    '';
  const name = configured || `nanoclaw-egress-v2-${getInstallSlug(projectRoot)}`;
  return validateRuntimeName(name, 'network');
}

interface NetworkRecord {
  configuration?: { mode?: string; name?: string };
  status?: { ipv4Gateway?: string; ipv4Subnet?: string };
}

function parseNetworkRecords(output: string): NetworkRecord[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? (parsed as NetworkRecord[]) : [parsed as NetworkRecord];
  } catch {
    return [];
  }
}

/**
 * The host's address on this network — what a container on it uses to reach a
 * port the host published. Pure, so the gateway provider and the tests read
 * the same parse.
 */
export function parseNetworkGateway(inspectOutput: string): string | null {
  return parseNetworkRecords(inspectOutput)[0]?.status?.ipv4Gateway ?? null;
}

/** Whether the runtime reports this network as host-only (no route off the host). */
export function parseNetworkIsolated(inspectOutput: string): boolean {
  return parseNetworkRecords(inspectOutput)[0]?.configuration?.mode === 'hostOnly';
}

function inspectNetwork(cli: Cli, name: string): string | null {
  try {
    return cli.run(['network', 'inspect', name], { timeoutMs: 15_000 });
  } catch {
    return null;
  }
}

/**
 * Ensure the install's egress network exists and is host-only, and return the
 * host address on it.
 *
 * Fail-closed on every branch. A network that exists but is NAT-mode is the
 * dangerous case: the sessions would start, reach the gateway, and also reach
 * the whole internet directly — the containment silently absent while
 * everything looks healthy. That is refused rather than repaired, because
 * deleting a network out from under whatever is using it is worse.
 */
export function ensureEgressNetwork(cli: Cli = realCli('container'), env: NodeJS.ProcessEnv = process.env): string {
  const name = egressNetworkName(env);

  let output = inspectNetwork(cli, name);
  if (!output) {
    try {
      cli.run(['network', 'create', '--internal', name], { timeoutMs: 30_000 });
    } catch (error) {
      throw new AppleEgressError(
        `the host-only network "${name}" could not be created: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    output = inspectNetwork(cli, name);
    log.info('Created host-only egress network', { network: name });
  }
  if (!output) {
    throw new AppleEgressError(`the host-only network "${name}" could not be inspected after creation`);
  }

  if (!parseNetworkIsolated(output)) {
    throw new AppleEgressError(
      `the network "${name}" exists but is not host-only, so sessions on it would have direct internet access. ` +
        `Remove it (\`container network rm ${name}\`) and let this install recreate it, or point ` +
        `NANOCLAW_EGRESS_NETWORK at a host-only network`,
    );
  }

  const gateway = parseNetworkGateway(output);
  if (!gateway) {
    throw new AppleEgressError(`the network "${name}" reports no IPv4 gateway address`);
  }
  return gateway;
}

/** CLI args placing a session on the install's host-only egress network. */
export function egressNetworkArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return ['--network', egressNetworkName(env)];
}

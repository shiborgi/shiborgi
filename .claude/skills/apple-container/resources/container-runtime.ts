/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 *
 * Supports two runtimes:
 *   - `docker` (default): the legacy path. Detected when CONTAINER_RUNTIME is unset
 *     or set to anything other than `container`.
 *   - `container` (Apple Container, macOS-only, CLI 1.1.0+): selected by
 *     CONTAINER_RUNTIME=container in .env. Native micro-VM containerization,
 *     no Docker dependency. Requires `/use-native-credential-proxy` for
 *     Anthropic credentials; see .claude/skills/apple-container/SKILL.md.
 *
 * Selection is env-driven and resolved once at module load so existing
 * callers (`container-runner.ts`, `egress-lockdown.ts`) keep their import
 * surface (`CONTAINER_RUNTIME_BIN`, `hostGatewayArgs()`, etc.).
 */
import { execSync, execFileSync } from 'child_process';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

/** Env var that selects the runtime binary. Default: docker. */
export const CONTAINER_RUNTIME_ENV = 'CONTAINER_RUNTIME';

/** Resolves the runtime identifier from process.env. Idempotent. */
function resolveContainerRuntime(): 'docker' | 'container' {
  const v = (process.env[CONTAINER_RUNTIME_ENV] ?? '').trim().toLowerCase();
  return v === 'container' ? 'container' : 'docker';
}

/**
 * The container runtime binary name.
 *
 * Exported as a `const` for call-site compatibility with the legacy
 * import surface (`import { CONTAINER_RUNTIME_BIN } from ...`). Resolved
 * once at module load from `process.env.CONTAINER_RUNTIME`; the run-time
 * fork happens in the four pure functions below.
 */
export const CONTAINER_RUNTIME_BIN = resolveContainerRuntime();

/** Apple Container 1.1.0 creates a bridge interface named `bridge100`
 *  with an inet address in 192.168.64.0/24. The container can resolve
 *  `host.docker.internal` to this IP; we inject it explicitly via
 *  `--add-host` because not every Apple Container 1.1.0 build wires the
 *  literal hostname automatically. */
const APPLE_BRIDGE_INTERFACE = 'bridge100';
const APPLE_BRIDGE_IP_ENV = 'APPLE_CONTAINER_BRIDGE_IP';

/**
 * Detect Apple Container's bridge100 gateway IP. Used by both
 * `hostGatewayArgs()` (runtime resolution) and the optional
 * `src/index.ts` pre-warm step that persists the value to .env.
 *
 * Cached on the first call so we don't re-run ifconfig on every
 * container spawn. Tests can reset the cache by deleting the cached
 * field on the function (see container-runtime.test.ts).
 */
let _appleBridgeIpCache: string | null | undefined;
export function getAppleBridgeIp(): string | null {
  if (_appleBridgeIpCache !== undefined) return _appleBridgeIpCache;
  const envPrefilled = process.env[APPLE_BRIDGE_IP_ENV];
  if (envPrefilled && envPrefilled.trim()) {
    _appleBridgeIpCache = envPrefilled.trim();
    return _appleBridgeIpCache;
  }
  try {
    const out = execFileSync('ifconfig', [APPLE_BRIDGE_INTERFACE], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const match = out.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
    _appleBridgeIpCache = match ? match[1] : null;
    return _appleBridgeIpCache;
  } catch {
    _appleBridgeIpCache = null;
    return null;
  }
}

/** Reset the ifconfig cache. Tests + the index.ts pre-warm hook call this
 *  after they set APPLE_CONTAINER_BRIDGE_IP manually. */
export function _resetAppleBridgeIpCache(): void {
  _appleBridgeIpCache = undefined;
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  if (CONTAINER_RUNTIME_BIN === 'container') {
    // Apple Container: explicit --add-host so the container can reach the
    // gateway regardless of how the micro-VM's DNS is wired.
    const ip = getAppleBridgeIp();
    if (ip) return ['--add-host=host.docker.internal:' + ip];
    // Without bridge100 we can't promise a reachable gateway. Fall through
    // to the bare literal — Apple Container 1.1.0 sometimes resolves it
    // automatically; let the runtime try before the user has to dig.
    return ['--add-host=host.docker.internal:host.docker.internal'];
  }
  // Docker path (unchanged)
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  if (CONTAINER_RUNTIME_BIN === 'container') {
    // Apple Container: `container stop <name>` (no `-t` flag in 1.1.0;
    // the timeout is implicit). Direct invocation — execFileSync already
    // rejects on non-zero, so a container that's already stopped surfaces
    // as an exception the caller can ignore.
    execFileSync('container', ['stop', name], { stdio: 'pipe' });
    return;
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  if (CONTAINER_RUNTIME_BIN === 'container') {
    try {
      execFileSync('container', ['system', 'status'], {
        stdio: 'pipe',
        timeout: 10000,
      });
      log.debug('Apple Container system already running');
      return;
    } catch {
      // Try to bring it up. Apple Container's own CLI hands back control
      // quickly once the VM is warm; the timeout is generous because
      // first-run VM provisioning can take ~30s.
      try {
        execFileSync('container', ['system', 'start'], {
          stdio: 'pipe',
          timeout: 60000,
        });
        log.info('Apple Container system started');
      } catch (err) {
        log.error('Failed to start Apple Container', { err });
        console.error('\n╔════════════════════════════════════════════════════════════════╗');
        console.error('║  FATAL: Container runtime failed to start                      ║');
        console.error('║                                                                ║');
        console.error('║  Agents cannot run without a container runtime. To fix:        ║');
        console.error('║  1. Ensure `container` CLI is installed (Apple Container)     ║');
        console.error('║  2. Run: container system start                                ║');
        console.error('║  3. Restart NanoClaw                                           ║');
        console.error('╚════════════════════════════════════════════════════════════════╝\n');
        throw new Error('Container runtime is required but failed to start', {
          cause: err,
        });
      }
    }
  }
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 *
 * On Apple Container, the CLI emits JSON instead of Go templates, and
 * `ps --filter label=…` is not supported — the install label is set on
 * each container as part of `container run`, so we filter the JSON list
 * by the label the host stamps (`nanoclaw-install=<slug>` in
 * `data/labels`), and fall back to the `nanoclaw-v2-` container-name
 * prefix as a safety net.
 */
export function cleanupOrphans(): void {
  if (CONTAINER_RUNTIME_BIN === 'container') {
    try {
      const raw = execFileSync('container', ['ls', '--format', 'json'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const items = JSON.parse(raw) as Array<{
        labels?: Record<string, string>;
        configuration?: { labels?: Record<string, string> };
        names?: string[];
      }>;
      const orphans = items
        .filter((c) => {
          const labels = { ...(c.labels ?? {}), ...(c.configuration?.labels ?? {}) };
          return labels['nanoclaw-install'] === process.env.NANOCLAW_INSTALL_SLUG
            || (c.names ?? []).some((n) => n.startsWith('nanoclaw-v2-'));
        })
        .flatMap((c) => c.names ?? []);
      for (const name of orphans) {
        try {
          stopContainer(name);
        } catch {
          /* already stopped */
        }
      }
      if (orphans.length > 0) {
        log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
      }
    } catch (err) {
      log.warn('Failed to clean up orphaned containers', { err });
    }
    return;
  }

  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}

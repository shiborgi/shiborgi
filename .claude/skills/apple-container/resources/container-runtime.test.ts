import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock log
vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
const mockExecFileSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
  getAppleBridgeIp,
  _resetAppleBridgeIpCache,
} from './container-runtime.js';
import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

beforeEach(() => {
  vi.clearAllMocks();
  // Default: docker mode for backwards-compatible test runs.
  process.env.CONTAINER_RUNTIME = 'docker';
  delete process.env.APPLE_CONTAINER_BRIDGE_IP;
  _resetAppleBridgeIpCache();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

// --- Docker mode (default) ---

describe('stopContainer (docker mode)', () => {
  it('calls docker stop for valid container names', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-test-123`, {
      stdio: 'pipe',
    });
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow('Invalid container name');
    expect(() => stopContainer('foo$(whoami)')).toThrow('Invalid container name');
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

describe('ensureContainerRuntimeRunning (docker mode)', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(log.debug).toHaveBeenCalledWith('Container runtime already running');
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow('Container runtime is required but failed to start');
    expect(log.error).toHaveBeenCalled();
  });
});

describe('cleanupOrphans (docker mode)', () => {
  it('filters ps by the install label so peers are not reaped', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      expect.any(Object),
    );
  });

  it('stops orphaned nanoclaw containers', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-group1-111\nnanoclaw-group2-222\n');
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(2, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group1-111`, {
      stdio: 'pipe',
    });
    expect(mockExecSync).toHaveBeenNthCalledWith(3, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group2-222`, {
      stdio: 'pipe',
    });
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'],
    });
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans();

    expect(log.warn).toHaveBeenCalledWith(
      'Failed to clean up orphaned containers',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-a-1', 'nanoclaw-b-2'],
    });
  });
});

// --- Apple Container mode ---

describe('Apple Container mode', () => {
  beforeEach(() => {
    process.env.CONTAINER_RUNTIME = 'container';
    _resetAppleBridgeIpCache();
    // Re-import so the const CONTAINER_RUNTIME_BIN is re-evaluated. Since
    // it's already resolved at module load, we instead test the *function*
    // behavior with the runtime-aware branches. The const is forced by
    // setting the env before module load in a separate describe block.
  });

  // The `CONTAINER_RUNTIME_BIN` const is captured at module load time, so
  // changing the env mid-suite does not affect it. The branches that read
  // it are tested via the runtime-detecting paths; the const's value is
  // verified by the static-import test at the bottom of this file.

  it('getAppleBridgeIp returns ip when ifconfig matches bridge100', () => {
    mockExecFileSync.mockReturnValueOnce(
      'bridge100: flags=8863<UP,BROADCAST,RUNNING,SIMPLEX,MULTICAST> mtu 1500\n' +
        '\tinet 192.168.64.1 netmask 0xffffff00 broadcast 192.168.64.255\n',
    );

    expect(getAppleBridgeIp()).toBe('192.168.64.1');

    // Cached — a second call does not re-run ifconfig
    mockExecFileSync.mockClear();
    expect(getAppleBridgeIp()).toBe('192.168.64.1');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('getAppleBridgeIp returns null when ifconfig fails', () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('ifconfig: interface bridge100 does not exist');
    });

    expect(getAppleBridgeIp()).toBeNull();
  });

  it('getAppleBridgeIp returns null when no inet line is present', () => {
    mockExecFileSync.mockReturnValueOnce('bridge100: flags=8863<UP,...> mtu 1500\n');

    expect(getAppleBridgeIp()).toBeNull();
  });

  it('getAppleBridgeIp respects APPLE_CONTAINER_BRIDGE_IP env override', () => {
    process.env.APPLE_CONTAINER_BRIDGE_IP = '10.0.0.42';
    _resetAppleBridgeIpCache();

    expect(getAppleBridgeIp()).toBe('10.0.0.42');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});

describe('CONTAINER_RUNTIME_BIN constant (module-load resolution)', () => {
  it('resolves to "docker" when CONTAINER_RUNTIME is unset at module load', async () => {
    // Use a dynamic re-import to exercise the module-load resolver. The
    // default is docker; this confirms the fallback path. We re-import by
    // changing the cache key trick (vi.resetModules + re-import) and
    // confirm that without an env var, the constant lands on 'docker'.
    delete process.env.CONTAINER_RUNTIME;
    vi.resetModules();
    const mod = await import('./container-runtime.js');
    expect(mod.CONTAINER_RUNTIME_BIN).toBe('docker');
  });

  it('resolves to "container" when CONTAINER_RUNTIME=container at module load', async () => {
    process.env.CONTAINER_RUNTIME = 'container';
    vi.resetModules();
    const mod = await import('./container-runtime.js');
    expect(mod.CONTAINER_RUNTIME_BIN).toBe('container');
    delete process.env.CONTAINER_RUNTIME;
  });
});

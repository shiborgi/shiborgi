import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Static mocks: hoisted by vitest before the module under test resolves.
// Each test case reassigns the mock module via vi.doMock + dynamic import
// to swap the runtime/lockdown state.
const mockContainerRuntime = vi.hoisted(() => ({
  CONTAINER_RUNTIME_BIN: 'docker',
}));
const mockConfig = vi.hoisted(() => ({
  EGRESS_LOCKDOWN: false,
  EGRESS_NETWORK: 'nanoclaw-egress',
  ONECLI_GATEWAY_CONTAINER: 'onecli-gateway-1',
}));

vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

const mockExecFileSync = vi.fn();
vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('./container-runtime.js', () => mockContainerRuntime);
vi.mock('./config.js', () => mockConfig);

beforeEach(() => {
  vi.clearAllMocks();
  mockContainerRuntime.CONTAINER_RUNTIME_BIN = 'docker';
  mockConfig.EGRESS_LOCKDOWN = false;
  mockConfig.EGRESS_NETWORK = 'nanoclaw-egress';
  mockConfig.ONECLI_GATEWAY_CONTAINER = 'onecli-gateway-1';
});

describe('ensureEgressNetwork', () => {
  it('returns false and skips docker entirely when lockdown is off', async () => {
    const { ensureEgressNetwork } = await import('./egress-lockdown.js');
    expect(ensureEgressNetwork()).toBe(false);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('returns false in Apple Container without touching docker networks', async () => {
    mockContainerRuntime.CONTAINER_RUNTIME_BIN = 'container';
    mockConfig.EGRESS_LOCKDOWN = true;
    vi.resetModules();
    const { ensureEgressNetwork } = await import('./egress-lockdown.js');
    expect(ensureEgressNetwork()).toBe(false);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('throws EgressLockdownError when Docker lockdown cannot create the network', async () => {
    mockConfig.EGRESS_LOCKDOWN = true;
    vi.resetModules();
    // Both `docker network inspect` and `docker network create --internal` fail
    mockExecFileSync.mockImplementation(() => {
      throw new Error('docker not available');
    });
    const { ensureEgressNetwork, EgressLockdownError } = await import('./egress-lockdown.js');
    expect(() => ensureEgressNetwork()).toThrow(EgressLockdownError);
  });
});

describe('egressNetworkArgs', () => {
  it('returns the network arg tuple expected by container-runner', async () => {
    const { egressNetworkArgs } = await import('./egress-lockdown.js');
    expect(egressNetworkArgs()).toEqual(['--network', 'nanoclaw-egress']);
  });
});

import { describe, it, expect, vi } from 'vitest';

vi.mock('./providers/provider-container-registry.js', () => ({
  getProviderContainerConfig: vi.fn(),
}));

import { getProviderContainerConfig } from './providers/provider-container-registry.js';
import { resolveProviderContribution, resolveProviderName } from './container-provider.js';
import type { AgentGroup, Session } from './types.js';
import type { ContainerConfig } from './container-config.js';

function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    last_message_at: null,
    last_message_seq: null,
    last_processing_ack: null,
    ...overrides,
  } as Session;
}

function mkAgentGroup(overrides: Partial<AgentGroup> = {}): AgentGroup {
  return {
    id: 'ag-1',
    folder: 'ag-1-folder',
    name: 'Agent One',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as AgentGroup;
}

const mkContainerConfig: ContainerConfig = {
  skills: 'all',
  additionalMounts: [],
  provider: undefined,
  imageTag: undefined,
  packages: { apt: [], npm: [] },
  mcpServers: {},
};

describe('resolveProviderName', () => {
  it('prefers session.provider over containerConfigs.provider', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container-config provider when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it("defaults to 'claude' when both are unset", () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty strings as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('resolveProviderContribution', () => {
  it('returns the contribution from the registry fn when present', () => {
    vi.mocked(getProviderContainerConfig).mockReturnValue(
      () => ({ mounts: [{ hostPath: '/x', containerPath: '/y', readonly: false }] }),
    );

    const { provider, contribution } = resolveProviderContribution(
      mkSession({ agent_provider: 'codex' }),
      mkAgentGroup(),
      mkContainerConfig,
      ['skill-a'],
    );

    expect(provider).toBe('codex');
    expect(contribution.mounts).toEqual([{ hostPath: '/x', containerPath: '/y', readonly: false }]);
  });

  it('returns an empty contribution when no provider fn is registered', () => {
    vi.mocked(getProviderContainerConfig).mockReturnValue(undefined);

    const { provider, contribution } = resolveProviderContribution(
      mkSession({ agent_provider: 'unknown-provider' }),
      mkAgentGroup(),
      mkContainerConfig,
      [],
    );

    expect(provider).toBe('unknown-provider');
    expect(contribution).toEqual({});
  });

  it('threads selectedSkills into the contribution fn', () => {
    const spyFn = vi.fn().mockReturnValue({});
    vi.mocked(getProviderContainerConfig).mockReturnValue(spyFn);

    resolveProviderContribution(
      mkSession(),
      mkAgentGroup(),
      mkContainerConfig,
      ['one', 'two', 'three'],
    );

    expect(spyFn).toHaveBeenCalledOnce();
    const arg = spyFn.mock.calls[0][0];
    expect(arg.selectedSkills).toEqual(['one', 'two', 'three']);
    expect(arg.agentGroupId).toBe('ag-1');
    expect(arg.sessionDir).toMatch(/ag-1[\\\/]sess-1$/);
  });
});

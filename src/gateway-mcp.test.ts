/**
 * MCP routing: what an agent's config says after the gateway has had its say.
 *
 * The properties that matter are (1) an HTTP server is reachable only through
 * the gateway, (2) nothing that was a credential survives into a file the
 * agent can read, and (3) a local stdio tool is not broken by a policy about
 * network servers.
 */
import { describe, expect, it, vi } from 'vitest';

import type { McpServerConfig } from './container-config.js';
import { applyMcpRouting, gatewayMcpUrl, routeMcpThroughGateway } from './gateway-mcp.js';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const BASE = 'http://192.168.128.9:8080';

describe('routing', () => {
  it('points an HTTP server at the gateway endpoint that shares its name', () => {
    const servers: Record<string, McpServerConfig> = {
      notes: { type: 'http', url: 'https://mcp.example.com/mcp' },
    };
    const { servers: out, routed } = routeMcpThroughGateway(servers, BASE);
    expect(out.notes).toEqual({ type: 'http', url: `${BASE}/mcp/notes` });
    expect(routed).toEqual(['notes']);
  });

  it('drops headers, so no credential survives into a file the agent can read', () => {
    const servers: Record<string, McpServerConfig> = {
      notes: {
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer real-upstream-secret' },
      },
    };
    const { servers: out } = routeMcpThroughGateway(servers, BASE);
    expect(JSON.stringify(out)).not.toContain('real-upstream-secret');
    expect('headers' in out.notes!).toBe(false);
  });

  it('keeps the upstream URL out of the agent entirely', () => {
    const servers: Record<string, McpServerConfig> = {
      notes: { type: 'http', url: 'https://internal.example.com/private/mcp' },
    };
    const { servers: out } = routeMcpThroughGateway(servers, BASE);
    expect(JSON.stringify(out)).not.toContain('internal.example.com');
  });

  it('preserves the fields the runner still needs', () => {
    const servers: Record<string, McpServerConfig> = {
      notes: {
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        plugin: 'notes-plugin',
        instructions: 'use for notes',
      },
    };
    const { servers: out } = routeMcpThroughGateway(servers, BASE);
    expect(out.notes).toMatchObject({ plugin: 'notes-plugin', instructions: 'use for notes' });
  });

  it('leaves a local stdio tool untouched', () => {
    const stdio: McpServerConfig = { command: 'bun', args: ['run', 'local.ts'], env: { A: 'b' } };
    const { servers: out, routed, local } = routeMcpThroughGateway({ tool: stdio }, BASE);
    expect(out.tool).toEqual(stdio);
    expect(local).toEqual(['tool']);
    expect(routed).toEqual([]);
  });

  it('resolves an explicit gateway route without retaining an upstream URL', () => {
    const { servers, routed } = routeMcpThroughGateway({ drive: { type: 'gateway', route: 'google-drive' } }, BASE);
    expect(servers.drive).toEqual({ type: 'http', url: `${BASE}/mcp/google-drive` });
    expect(routed).toEqual(['google-drive']);
  });

  it('handles a mixed set without cross-contamination', () => {
    const { routed, local } = routeMcpThroughGateway(
      {
        remote: { type: 'http', url: 'https://a/mcp' },
        localTool: { command: 'x' },
        another: { type: 'http', url: 'https://b/mcp' },
      },
      BASE,
    );
    expect(routed.sort()).toEqual(['another', 'remote']);
    expect(local).toEqual(['localTool']);
  });

  it('is a no-op on an empty set', () => {
    expect(routeMcpThroughGateway({}, BASE)).toEqual({ servers: {}, routed: [], local: [] });
  });

  it('does not double a slash when the base carries a trailing one', () => {
    expect(gatewayMcpUrl('http://gw:8080/', 'notes')).toBe('http://gw:8080/mcp/notes');
  });
});

describe('applyMcpRouting', () => {
  it('rewrites the config the container will read', () => {
    const config = { mcpServers: { notes: { type: 'http' as const, url: 'https://mcp.example.com/mcp' } } };
    applyMcpRouting(config, BASE, 'ag-bar');
    expect(config.mcpServers.notes!).toEqual({ type: 'http', url: `${BASE}/mcp/notes` });
  });
});

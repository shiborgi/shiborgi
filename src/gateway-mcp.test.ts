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
import {
  applyMcpRouting,
  gatewayMcpUrl,
  routeMcpThroughGateway,
  stripUnroutableGatewayServers,
} from './gateway-mcp.js';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const BASE = 'http://192.168.128.9:8080';
/** The session's own bearer, as gateway-mcp-transform derives it per spawn. */
const AUTH = 'Bearer ncl.ag-bar.deadbeef';

describe('routing', () => {
  it('points an HTTP server at the gateway endpoint that shares its name', () => {
    const servers: Record<string, McpServerConfig> = {
      notes: { type: 'http', url: 'https://mcp.example.com/mcp' },
    };
    const { servers: out, routed } = routeMcpThroughGateway(servers, BASE, AUTH);
    expect(out.notes).toEqual({ type: 'http', url: `${BASE}/mcp/notes`, headers: { Authorization: AUTH } });
    expect(routed).toEqual(['notes']);
  });

  it('replaces the upstream credential with the session bearer', () => {
    const servers: Record<string, McpServerConfig> = {
      notes: {
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer real-upstream-secret' },
      },
    };
    const { servers: out } = routeMcpThroughGateway(servers, BASE, AUTH);
    // The upstream secret is gone; what remains identifies the caller to the
    // gateway and is already in the agent's own environment.
    expect(JSON.stringify(out)).not.toContain('real-upstream-secret');
    expect(out.notes).toMatchObject({ headers: { Authorization: AUTH } });
  });

  it('keeps the upstream URL out of the agent entirely', () => {
    const servers: Record<string, McpServerConfig> = {
      notes: { type: 'http', url: 'https://internal.example.com/private/mcp' },
    };
    const { servers: out } = routeMcpThroughGateway(servers, BASE, AUTH);
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
    const { servers: out } = routeMcpThroughGateway(servers, BASE, AUTH);
    expect(out.notes).toMatchObject({ plugin: 'notes-plugin', instructions: 'use for notes' });
  });

  it('leaves a local stdio tool untouched', () => {
    const stdio: McpServerConfig = { command: 'bun', args: ['run', 'local.ts'], env: { A: 'b' } };
    const { servers: out, routed, local } = routeMcpThroughGateway({ tool: stdio }, BASE, AUTH);
    expect(out.tool).toEqual(stdio);
    expect(local).toEqual(['tool']);
    expect(routed).toEqual([]);
  });

  it('resolves an explicit gateway route without retaining an upstream URL', () => {
    const { servers, routed } = routeMcpThroughGateway(
      { drive: { type: 'gateway', route: 'google-drive' } },
      BASE,
      AUTH,
    );
    expect(servers.drive).toEqual({
      type: 'http',
      url: `${BASE}/mcp/google-drive`,
      headers: { Authorization: AUTH },
    });
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
      AUTH,
    );
    expect(routed.sort()).toEqual(['another', 'remote']);
    expect(local).toEqual(['localTool']);
  });

  it('is a no-op on an empty set', () => {
    expect(routeMcpThroughGateway({}, BASE, AUTH)).toEqual({ servers: {}, routed: [], local: [] });
  });

  it('does not double a slash when the base carries a trailing one', () => {
    expect(gatewayMcpUrl('http://gw:8080/', 'notes')).toBe('http://gw:8080/mcp/notes');
  });
});

describe('applyMcpRouting', () => {
  it('rewrites the config the container will read', () => {
    const config = { mcpServers: { notes: { type: 'http' as const, url: 'https://mcp.example.com/mcp' } } };
    applyMcpRouting(config, BASE, 'ag-bar', AUTH);
    expect(config.mcpServers.notes!).toEqual({
      type: 'http',
      url: `${BASE}/mcp/notes`,
      headers: { Authorization: AUTH },
    });
  });
});

/*
 * The container's own config type has no gateway variant, on the strength of
 * this: past the transform, every server in container.json is one something
 * can dial. An install with no gateway cannot resolve a route, so the entry
 * must not survive — otherwise the agent meets a tool that always fails, and
 * every consumer downstream has to model a case that only ever means "broken".
 */
describe('stripUnroutableGatewayServers', () => {
  it('drops a gateway route and keeps everything reachable', () => {
    const config: { mcpServers: Record<string, McpServerConfig> } = {
      mcpServers: {
        lastro: { type: 'gateway', route: 'lastro' },
        remote: { type: 'http', url: 'https://mcp.example.com/mcp' },
        localTool: { command: 'x' },
      },
    };
    stripUnroutableGatewayServers(config, 'ag-bar');
    expect(Object.keys(config.mcpServers).sort()).toEqual(['localTool', 'remote']);
  });

  it('leaves a config carrying no route byte-identical', () => {
    const servers: Record<string, McpServerConfig> = { localTool: { command: 'x' } };
    const config = { mcpServers: servers };
    stripUnroutableGatewayServers(config, 'ag-bar');
    expect(config.mcpServers).toBe(servers);
  });
});

/**
 * Routing a group's MCP servers through the gateway.
 *
 * An agent has no route off the host, so an MCP server it reaches must be one
 * the gateway proxies. The group's config names servers; the gateway holds
 * their real URLs and credentials. This rewrites the former into the latter's
 * endpoints at materialization time.
 *
 * Why here and not in stored config: the gateway's address is DHCP-assigned on
 * the host-only network and changes whenever the container is recreated. A URL
 * frozen into `container_configs` would be correct until the first gateway
 * restart and silently wrong afterwards. `container.json` is rewritten on every
 * spawn anyway, so resolving the address there costs nothing and cannot go
 * stale.
 *
 * The name is the join key: `mcpServers.notes` in a group's config reaches
 * `mcpServers.notes` in `gateway.json`. Nothing else is carried across, and
 * that is the point — the upstream URL and its credential stay on the gateway,
 * so an agent that reads its own `container.json` learns only that a tool
 * called `notes` exists and that the gateway is how to reach it.
 *
 * stdio servers are left alone. They run inside the agent container and need
 * no egress — a plugin's local tool is legitimate and must not be broken by a
 * policy about network servers. One that DOES want the network will fail
 * visibly at its first call rather than be silently rerouted somewhere it was
 * never configured to go.
 */
import type { McpServerConfig } from './container-config.js';
import { log } from './log.js';

export interface McpRoutingResult {
  servers: Record<string, McpServerConfig>;
  /** Names now pointed at the gateway. */
  routed: string[];
  /** stdio names left running inside the agent container. */
  local: string[];
}

/** The gateway endpoint that proxies one named MCP server. */
export function gatewayMcpUrl(gatewayBaseUrl: string, name: string): string {
  return `${gatewayBaseUrl.replace(/\/+$/, '')}/mcp/${name}`;
}

export function routeMcpThroughGateway(
  servers: Record<string, McpServerConfig>,
  gatewayBaseUrl: string,
): McpRoutingResult {
  const out: Record<string, McpServerConfig> = {};
  const routed: string[] = [];
  const local: string[] = [];

  for (const [name, server] of Object.entries(servers)) {
    if (server.type === 'gateway') {
      out[name] = {
        type: 'http',
        url: gatewayMcpUrl(gatewayBaseUrl, server.route),
        ...(server.instructions ? { instructions: server.instructions } : {}),
      };
      routed.push(server.route);
      continue;
    }
    if (server.type === 'http') {
      // `headers` is dropped deliberately: any credential it carried is the
      // gateway's to hold now, and leaving a stale one in the agent's config
      // would put a secret in a file the agent can read for no benefit.
      out[name] = {
        type: 'http',
        url: gatewayMcpUrl(gatewayBaseUrl, name),
        ...(server.plugin ? { plugin: server.plugin } : {}),
        ...(server.instructions ? { instructions: server.instructions } : {}),
      };
      routed.push(name);
      continue;
    }
    out[name] = server;
    local.push(name);
  }

  return { servers: out, routed, local };
}

/** Apply the routing to a config object in place, and say what happened. */
export function applyMcpRouting(
  config: { mcpServers: Record<string, McpServerConfig> },
  gatewayBaseUrl: string,
  agentGroupId: string,
): void {
  const { servers, routed, local } = routeMcpThroughGateway(config.mcpServers, gatewayBaseUrl);
  config.mcpServers = servers;
  if (routed.length > 0 || local.length > 0) {
    log.info('MCP servers resolved for session', { agentGroupId, viaGateway: routed, insideContainer: local });
  }
}

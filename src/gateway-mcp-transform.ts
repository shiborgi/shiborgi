/**
 * The spawn path's hook for gateway-routed MCP.
 *
 * Separate from `gateway-mcp.ts` so the routing itself stays pure and
 * testable, and separate from `container-config.ts` so config materialization
 * never learns what a gateway is. This module is the only place the two meet.
 *
 * On an install whose gateway is something else (OneCLI), there is nothing to
 * route through, so the transform strips gateway routes instead of resolving
 * them. Config without such a route materializes byte-identically either way;
 * config with one loses an entry that could never have worked, and the host
 * log says so. That is what makes `type: 'gateway'` unreachable past this
 * point, which every downstream consumer — the container included — relies on.
 */
import type { ContainerConfig } from './container-config.js';
import { ensureGatewaySecret } from './gateway-bootstrap.js';
import { gatewayBaseUrl, resolveGatewayAddress } from './gateway-container.js';
import { bearerFor } from './gateway-identity.js';
import { applyMcpRouting, stripUnroutableGatewayServers } from './gateway-mcp.js';
import { configuredGatewayProviderKind } from './gateway-providers/index.js';

export function mcpGatewayTransform(agentGroupId: string): (config: ContainerConfig) => void {
  if (configuredGatewayProviderKind() !== 'gateway') {
    return (config) => stripUnroutableGatewayServers(config, agentGroupId);
  }
  return (config) => {
    // Resolving here also ENSURES the gateway is up, which is what makes the
    // first spawn on a fresh machine bring the whole stack with it.
    // The same bearer the session's environment carries: the gateway
    // authenticates its MCP endpoints exactly as it does the model ones, so a
    // routed entry has to present it or every tool call comes back 401.
    applyMcpRouting(
      config,
      gatewayBaseUrl(resolveGatewayAddress()),
      agentGroupId,
      bearerFor(ensureGatewaySecret(), agentGroupId),
    );
  };
}

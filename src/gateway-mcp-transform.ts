/**
 * The spawn path's hook for gateway-routed MCP.
 *
 * Separate from `gateway-mcp.ts` so the routing itself stays pure and
 * testable, and separate from `container-config.ts` so config materialization
 * never learns what a gateway is. This module is the only place the two meet.
 *
 * Returns `undefined` — not a no-op function — when this install's gateway is
 * something else, so an install on OneCLI materializes byte-identical config
 * to what it did before this existed.
 */
import type { ContainerConfig } from './container-config.js';
import { gatewayBaseUrl, resolveGatewayAddress } from './gateway-container.js';
import { applyMcpRouting } from './gateway-mcp.js';
import { configuredGatewayProviderKind } from './gateway-providers/index.js';

export function mcpGatewayTransform(agentGroupId: string): ((config: ContainerConfig) => void) | undefined {
  if (configuredGatewayProviderKind() !== 'gateway') return undefined;
  return (config) => {
    // Resolving here also ENSURES the gateway is up, which is what makes the
    // first spawn on a fresh machine bring the whole stack with it.
    applyMcpRouting(config, gatewayBaseUrl(resolveGatewayAddress()), agentGroupId);
  };
}

/**
 * The in-tree gateway — this project's egress provider.
 *
 * What crosses into the agent's environment is an address and an identity
 * token, and nothing else. Every upstream credential (the model provider's
 * key, an MCP server's bearer) stays in the gateway's own config, mounted into
 * the gateway container and readable nowhere else. An agent that dumps its
 * whole environment learns where the gateway is and who it is — not how to
 * call anything directly, and in any case it has no route to try.
 *
 * Fail-closed by contract: a throw here aborts the spawn, the inbound row stays
 * pending, and the next sweep tick retries. A session whose only way out is a
 * gateway that is not answering has nothing useful to do, and starting it
 * would surface as a confusing model error several seconds later instead of a
 * named cause here.
 */
import { readEnvFile } from '../env.js';
import { awaitGatewayLive, gatewayBaseUrl, gatewayLogTail, resolveGatewayAddress } from '../gateway-container.js';
import { GATEWAY_SECRET_ENV, deriveClientKey } from '../gateway-identity.js';
import { log } from '../log.js';

import { registerGatewayProvider, type GatewayContribution } from './gateway-provider-registry.js';

/**
 * The env one session needs to reach the gateway.
 *
 * Pure, so the contract is testable without a runtime: given an address and a
 * client key, this is exactly what lands on the contributed lane.
 *
 * `ANTHROPIC_*` and `OPENAI_*` are both set because the two agent providers
 * this install runs read different pairs — the Claude provider takes
 * `ANTHROPIC_BASE_URL`, and OpenCode passes its configured `baseURL` from the
 * same key — and the gateway answers one OpenAI-compatible surface either way.
 * Naming both costs nothing and removes a class of "works with one provider,
 * silently direct with the other" bug.
 *
 * `NO_PROXY` keeps loopback traffic inside the container from being redirected
 * if a proxy variable is ever introduced alongside these.
 */
export function gatewaySessionEnv(address: string, clientKey: string): Record<string, string> {
  const base = gatewayBaseUrl(address);
  return {
    ANTHROPIC_BASE_URL: `${base}/v1`,
    ANTHROPIC_AUTH_TOKEN: clientKey,
    OPENAI_BASE_URL: `${base}/v1`,
    OPENAI_API_KEY: clientKey,
    // The MCP endpoints hang off the same base; the runner's server map is
    // rewritten to match at config materialization.
    NANOCLAW_GATEWAY_URL: base,
    NO_PROXY: '127.0.0.1,localhost',
  };
}

registerGatewayProvider('gateway', () => ({
  kind: 'gateway',
  async contribute({ key }): Promise<GatewayContribution> {
    const address = resolveGatewayAddress();
    if (!(await awaitGatewayLive())) {
      throw new Error(
        `the gateway at ${gatewayBaseUrl(address)} is not answering /health/live — refusing to spawn a session ` +
          `that would have no route to a model or an MCP server. Its last output:\n${gatewayLogTail()}`,
      );
    }

    const secret = readEnvFile([GATEWAY_SECRET_ENV])[GATEWAY_SECRET_ENV];
    if (!secret) {
      throw new Error(`${GATEWAY_SECRET_ENV} is not set in .env; the gateway cannot identify this agent group`);
    }

    log.info('Gateway contribution applied', { agentGroupId: key.agentGroupId, sessionId: key.sessionId, address });
    return { env: gatewaySessionEnv(address, deriveClientKey(secret, key.agentGroupId)) };
  },
}));

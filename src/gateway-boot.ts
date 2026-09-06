/**
 * Bringing the egress stack up at host start.
 *
 * On a machine that has never run this install there is no host-only network,
 * no gateway image and no gateway container. On one that rebooted, the network
 * survives but the container does not. Both cases are handled the same way,
 * because the underlying operations are idempotent: ensure the network, ensure
 * the image, ensure the container.
 *
 * Advisory, not fatal. `contribute()` resolves the gateway again on every spawn
 * and fails closed there, so nothing can slip through uncontained by skipping
 * this. What a throw here WOULD cost is the whole host: under a service manager
 * set to restart, a startup throw is a crash loop that takes every channel
 * adapter with it — including the one the operator would use to ask why. A
 * warning that names the problem, and a first message that retries, is the
 * better failure.
 */
import { configuredDriverKind } from './drivers/index.js';
import { awaitGatewayLive, ensureGatewayRunning, gatewayBaseUrl, gatewayLogTail } from './gateway-container.js';
import { configuredGatewayProviderKind } from './gateway-providers/index.js';
import { log } from './log.js';

export async function ensureEgressAtBoot(): Promise<void> {
  // Both halves of the topology are selectable, and only this pairing owns
  // these runtime objects. An install on Docker or OneCLI must not have an
  // Apple Container network created underneath it.
  if (configuredGatewayProviderKind() !== 'gateway' || configuredDriverKind() !== 'apple-container') return;

  try {
    // Creates the host-only network if absent, then places the gateway on it.
    const address = ensureGatewayRunning();
    const live = await awaitGatewayLive();
    if (live) {
      log.info('Egress gateway ready', { url: gatewayBaseUrl(address) });
      return;
    }
    // Its own output is the only thing that distinguishes "still booting" from
    // "exited on a bad config" or "image built without its source" — and with
    // `--rm` that output is about to disappear.
    log.warn('Egress gateway started but is not answering; the first session will retry', {
      url: gatewayBaseUrl(address),
      gatewayLogs: gatewayLogTail(),
    });
  } catch (err) {
    log.error('Could not bring up the egress gateway; sessions will not spawn until it is reachable', { err });
  }
}

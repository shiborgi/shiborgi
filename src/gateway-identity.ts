/**
 * Per-agent-group identity at the gateway.
 *
 * A session is handed one token that both NAMES the agent group and PROVES the
 * naming: `ncl.<agentGroupId>.<mac>`, where the mac is HMAC(installSecret,
 * agentGroupId). The gateway splits the id out, recomputes the mac, and
 * compares — so it learns which agent is calling over plain
 * `Authorization: Bearer`, with no custom header. That matters because the
 * LLM surface is OpenAI-compatible and its clients send nothing else.
 *
 * Self-describing rather than a lookup: there is no client registry to keep in
 * sync with the agent-group table, no write path on the spawn hot path, and no
 * bootstrap ordering to get wrong on a fresh machine.
 *
 * The property that matters: an agent knows only its OWN token. Claiming a
 * sibling's id means presenting a mac it cannot compute without the install
 * secret, which lives on the host and in the gateway container and never in an
 * agent container. So the bar assistant cannot spend the personal assistant's
 * model budget by relabelling itself.
 *
 * What rides in the agent's environment is this token and nothing else.
 * Upstream credentials — the model provider's key, an MCP server's bearer —
 * never leave the gateway; the agent cannot read one even by dumping its whole
 * environment, and has no route to use one if it could.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/** Long enough that forging is hopeless, short enough to read in a log line. */
const MAC_HEX_CHARS = 32;

export const GATEWAY_SECRET_ENV = 'NANOCLAW_GATEWAY_SECRET';

/** A fresh install secret, written to `.env` once and never rotated silently. */
export function generateGatewaySecret(): string {
  return randomBytes(32).toString('hex');
}

function mac(secret: string, agentGroupId: string): string {
  return createHmac('sha256', secret).update(agentGroupId).digest('hex').slice(0, MAC_HEX_CHARS);
}

/** The token one agent group presents. See the module comment for the shape. */
export function deriveClientKey(secret: string, agentGroupId: string): string {
  if (!secret) throw new Error(`${GATEWAY_SECRET_ENV} is not set; cannot derive a gateway client key`);
  if (agentGroupId.includes('.')) {
    // The separator has to stay unambiguous or the id could be split wrong on
    // the gateway side, which is an identity bug rather than a parse bug.
    throw new Error(`agent group id must not contain a dot: ${agentGroupId}`);
  }
  return `ncl.${agentGroupId}.${mac(secret, agentGroupId)}`;
}

/**
 * The agent group this token proves, or null.
 *
 * Timing-safe: a plain `===` on the mac leaks it byte by byte to a caller that
 * can retry, and the caller here is a semi-trusted agent container.
 */
export function verifyClientKey(secret: string, token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'ncl') return null;
  const agentGroupId = parts[1];
  const presented = Buffer.from(parts[2]);
  const expected = Buffer.from(mac(secret, agentGroupId));
  if (presented.length !== expected.length) return null;
  return timingSafeEqual(presented, expected) ? agentGroupId : null;
}

/** The `Authorization` value a session presents. */
export function bearerFor(secret: string, agentGroupId: string): string {
  return `Bearer ${deriveClientKey(secret, agentGroupId)}`;
}

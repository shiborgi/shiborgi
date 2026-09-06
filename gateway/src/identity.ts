/**
 * Which agent group is calling.
 *
 * The token both names the group and proves the naming — see
 * `src/gateway-identity.ts` on the host for the shape and the reasoning.
 *
 * This mirrors that module. The two trees are separate packages that share no
 * modules (the same split the host and the agent-runner already live with), so
 * the derivation is stated twice on purpose. `identity.test.ts` here and
 * `gateway-identity.test.ts` there pin the SAME vector, so a change made to
 * one and not the other fails a test rather than silently rejecting every
 * agent at runtime.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const MAC_HEX_CHARS = 32;

function mac(secret: string, agentGroupId: string): string {
  return createHmac('sha256', secret).update(agentGroupId).digest('hex').slice(0, MAC_HEX_CHARS);
}

/** The agent group this token proves, or null. Timing-safe on the mac. */
export function verifyClientKey(secret: string, token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'ncl') return null;
  const agentGroupId = parts[1]!;
  const presented = Buffer.from(parts[2]!);
  const expected = Buffer.from(mac(secret, agentGroupId));
  if (presented.length !== expected.length) return null;
  return timingSafeEqual(presented, expected) ? agentGroupId : null;
}

/** The bearer token out of an Authorization header, or null. */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

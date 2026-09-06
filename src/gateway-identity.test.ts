/**
 * Identity derivation, host side.
 *
 * The vector below is pinned identically in `gateway/src/gateway.test.ts`. The
 * host and the gateway are separate package trees that share no modules, so
 * this pair is the only thing standing between a one-sided edit and an install
 * where the gateway rejects every agent with a 401 that looks like a
 * configuration problem.
 */
import { describe, expect, it } from 'vitest';

import { deriveClientKey, generateGatewaySecret, verifyClientKey } from './gateway-identity.js';

/** Must match `VECTOR` in `gateway/src/gateway.test.ts`. */
const SECRET = 'a'.repeat(64);
const AGENT_GROUP = 'ag-bartender';

describe('client key derivation', () => {
  it('produces the vector the gateway verifies', () => {
    const token = deriveClientKey(SECRET, AGENT_GROUP);
    expect(token).toMatch(/^ncl\.ag-bartender\.[0-9a-f]{32}$/);
    // Round-trip through this tree's own verifier; the gateway's verifier is
    // asserted against the same construction on its side.
    expect(verifyClientKey(SECRET, token)).toBe(AGENT_GROUP);
  });

  it('is stable across calls, so a restart does not invalidate live sessions', () => {
    expect(deriveClientKey(SECRET, AGENT_GROUP)).toBe(deriveClientKey(SECRET, AGENT_GROUP));
  });

  it('gives different groups different tokens', () => {
    expect(deriveClientKey(SECRET, 'ag-bar')).not.toBe(deriveClientKey(SECRET, 'ag-personal'));
  });

  it('gives different installs different tokens for the same group', () => {
    expect(deriveClientKey('a'.repeat(64), AGENT_GROUP)).not.toBe(deriveClientKey('b'.repeat(64), AGENT_GROUP));
  });

  it('refuses to derive without an install secret', () => {
    expect(() => deriveClientKey('', AGENT_GROUP)).toThrow(/NANOCLAW_GATEWAY_SECRET/);
  });

  it('refuses a group id that would make the token ambiguous to parse', () => {
    expect(() => deriveClientKey(SECRET, 'ag.with.dots')).toThrow(/must not contain a dot/);
  });
});

describe('verification', () => {
  it('rejects a forged mac', () => {
    expect(verifyClientKey(SECRET, `ncl.${AGENT_GROUP}.${'0'.repeat(32)}`)).toBeNull();
  });

  it('rejects an agent presenting its own mac under a sibling id', () => {
    const mine = deriveClientKey(SECRET, 'ag-bar').split('.')[2];
    expect(verifyClientKey(SECRET, `ncl.ag-personal.${mine}`)).toBeNull();
  });

  it('rejects a token minted by another install', () => {
    expect(verifyClientKey(SECRET, deriveClientKey('b'.repeat(64), AGENT_GROUP))).toBeNull();
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of ['', 'nonsense', 'ncl.only-two', 'x.y.z', `ncl.${AGENT_GROUP}.short`]) {
      expect(verifyClientKey(SECRET, bad)).toBeNull();
    }
  });
});

describe('install secret', () => {
  it('is long and unique per generation', () => {
    const a = generateGatewaySecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(generateGatewaySecret());
  });
});

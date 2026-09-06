/**
 * The gateway's contract, driven through the real request handler.
 *
 * Upstreams are faked by stubbing `fetch`, so these assert what the gateway
 * DID — which credential it attached, which it refused to forward, what it
 * rewrote — rather than that its source mentions the right words.
 */
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { allows, authHeader, parseConfig, parseSecrets, policyFor, GatewayConfigError } from './config.js';
import { verifyClientKey } from './identity.js';

/**
 * The SAME vector pinned by `src/gateway-identity.test.ts` on the host. The
 * two trees share no modules, so this pair is what keeps their derivations
 * from drifting apart into an install where every agent is rejected.
 */
const VECTOR = {
  secret: 'a'.repeat(64),
  agentGroupId: 'ag-bartender',
  token: null as string | null,
};

describe('identity', () => {
  it('accepts a token derived from the same secret', () => {
    // Derived here the way the host derives it, then verified by the gateway.
    const mac = new Bun.CryptoHasher('sha256', VECTOR.secret).update(VECTOR.agentGroupId).digest('hex').slice(0, 32);
    const token = `ncl.${VECTOR.agentGroupId}.${mac}`;
    VECTOR.token = token;
    expect(verifyClientKey(VECTOR.secret, token)).toBe(VECTOR.agentGroupId);
  });

  it('rejects a token whose mac was not derived from this install secret', () => {
    expect(verifyClientKey(VECTOR.secret, `ncl.${VECTOR.agentGroupId}.${'0'.repeat(32)}`)).toBeNull();
  });

  it('rejects an agent claiming a sibling id it cannot mac for', () => {
    const mac = new Bun.CryptoHasher('sha256', VECTOR.secret).update('ag-bartender').digest('hex').slice(0, 32);
    // The bar assistant's own mac, presented under the personal assistant's id.
    expect(verifyClientKey(VECTOR.secret, `ncl.ag-personal.${mac}`)).toBeNull();
  });

  it('rejects malformed tokens without throwing', () => {
    expect(verifyClientKey(VECTOR.secret, 'nonsense')).toBeNull();
    expect(verifyClientKey(VECTOR.secret, 'ncl.only-two')).toBeNull();
    expect(verifyClientKey(VECTOR.secret, '')).toBeNull();
  });
});

describe('config', () => {
  const valid = JSON.stringify({
    schemaVersion: 1,
    upstreams: {
      anthropic: {
        baseUrl: 'https://api.anthropic.com/v1/',
        auth: { header: 'x-api-key', format: '{value}', secret: 'ANTHROPIC_API_KEY' },
      },
    },
    models: { default: { upstream: 'anthropic', model: 'claude-sonnet-5' } },
    mcpServers: { notes: { url: 'https://mcp.example.com/mcp' } },
    agents: { 'ag-bar': { models: ['default'], mcpServers: [] }, '*': { models: ['*'], mcpServers: ['*'] } },
  });

  it('parses a valid document and normalizes the base URL', () => {
    const config = parseConfig(valid);
    expect(config.upstreams.anthropic!.baseUrl).toBe('https://api.anthropic.com/v1');
    expect(config.models.default!.model).toBe('claude-sonnet-5');
  });

  it('refuses a model pointing at an upstream that does not exist', () => {
    const bad = JSON.stringify({
      schemaVersion: 1,
      upstreams: {},
      models: { default: { upstream: 'ghost' } },
      mcpServers: {},
      agents: {},
    });
    expect(() => parseConfig(bad)).toThrow(/not a configured upstream/);
  });

  it('refuses an auth format with no placeholder, which would send no credential at all', () => {
    const bad = JSON.stringify({
      schemaVersion: 1,
      upstreams: { x: { baseUrl: 'https://x', auth: { header: 'A', format: 'Bearer', secret: 'S' } } },
      models: {},
      mcpServers: {},
      agents: {},
    });
    expect(() => parseConfig(bad)).toThrow(/must contain \{value\}/);
  });

  it('refuses a schema version it does not understand', () => {
    expect(() => parseConfig(JSON.stringify({ schemaVersion: 99 }))).toThrow(/unsupported schemaVersion/);
  });

  it('resolves per-agent policy with a wildcard fallback', () => {
    const config = parseConfig(valid);
    expect(policyFor(config, 'ag-bar')!.models).toEqual(['default']);
    expect(policyFor(config, 'ag-unknown')!.models).toEqual(['*']);
    expect(allows(['*'], 'anything')).toBe(true);
    expect(allows(['a'], 'b')).toBe(false);
  });

  it('reads secrets and refuses to build a header for a missing one', () => {
    const secrets = parseSecrets('# comment\nANTHROPIC_API_KEY="sk-live"\n\nEMPTY=\n');
    expect(secrets.ANTHROPIC_API_KEY).toBe('sk-live');
    const auth = { header: 'x-api-key', format: '{value}', secret: 'ANTHROPIC_API_KEY' };
    expect(authHeader(auth, secrets)).toEqual({ name: 'x-api-key', value: 'sk-live' });
    expect(() => authHeader({ ...auth, secret: 'ABSENT' }, secrets)).toThrow(GatewayConfigError);
  });
});

describe('request handling', () => {
  const secret = 'b'.repeat(64);
  const mac = new Bun.CryptoHasher('sha256', secret).update('ag-bar').digest('hex').slice(0, 32);
  const token = `ncl.ag-bar.${mac}`;
  let seen: { url: string; headers: Headers; body: string } | null;
  let realFetch: typeof globalThis.fetch;
  let handle: (request: Request) => Promise<Response>;

  beforeEach(async () => {
    seen = null;
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen = { url: String(input), headers, body: String(init?.body ?? '') };
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;

    process.env.NANOCLAW_GATEWAY_SECRET = secret;
    // A temp dir, not `config/` — fixtures written beside the real policy would
    // be committed, and could be picked up by a running gateway.
    const dir = `${tmpdir()}/nanoclaw-gateway-test-${Bun.randomUUIDv7()}`;
    process.env.GATEWAY_CONFIG = `${dir}/gateway.json`;
    process.env.GATEWAY_SECRETS = `${dir}/secrets.env`;
    await Bun.write(
      process.env.GATEWAY_CONFIG,
      JSON.stringify({
        schemaVersion: 1,
        upstreams: {
          anthropic: {
            baseUrl: 'https://api.anthropic.com/v1',
            auth: { header: 'x-api-key', format: '{value}', secret: 'ANTHROPIC_API_KEY' },
          },
        },
        models: { default: { upstream: 'anthropic', model: 'claude-sonnet-5' } },
        mcpServers: {
          notes: { url: 'https://mcp.example.com/mcp', auth: { header: 'Authorization', format: 'Bearer {value}', secret: 'NOTES_TOKEN' } },
          secret_one: { url: 'https://mcp.example.com/other' },
        },
        agents: { 'ag-bar': { models: ['default'], mcpServers: ['notes'] } },
      }),
    );
    await Bun.write(process.env.GATEWAY_SECRETS, 'ANTHROPIC_API_KEY=sk-upstream\nNOTES_TOKEN=notes-upstream\n');

    // Imported after the env is in place: the module reads the secret at load.
    ({ handle } = await import(`./index.js?t=${Date.now()}`));
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    mock.restore();
  });

  function llm(body: unknown, auth = `Bearer ${token}`): Request {
    return new Request('http://gw/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('answers liveness without a token', async () => {
    const response = await handle(new Request('http://gw/health/live'));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('refuses an unauthenticated call', async () => {
    const response = await handle(new Request('http://gw/v1/chat/completions', { method: 'POST' }));
    expect(response.status).toBe(401);
  });

  it('attaches the upstream credential and never forwards the agent token', async () => {
    const response = await handle(llm({ model: 'default', messages: [] }));
    expect(response.status).toBe(200);
    expect(seen!.url).toBe('https://api.anthropic.com/v1/chat/completions');
    expect(seen!.headers.get('x-api-key')).toBe('sk-upstream');
    // The identity token is this install's, not the model provider's business.
    expect(seen!.headers.get('authorization')).toBeNull();
  });

  it('rewrites the model alias to the upstream name', async () => {
    await handle(llm({ model: 'default', messages: [] }));
    expect(JSON.parse(seen!.body).model).toBe('claude-sonnet-5');
  });

  it('refuses a model the agent is not allowed', async () => {
    const response = await handle(llm({ model: 'cheap', messages: [] }));
    expect(response.status).toBe(404);
    expect(seen).toBeNull();
  });

  it('refuses a request that names no model rather than guessing one', async () => {
    const response = await handle(llm({ messages: [] }));
    expect(response.status).toBe(400);
    expect(seen).toBeNull();
  });

  it('routes an allowed MCP server with its own credential', async () => {
    const response = await handle(
      new Request('http://gw/mcp/notes', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: '{"jsonrpc":"2.0"}',
      }),
    );
    expect(response.status).toBe(200);
    expect(seen!.url).toBe('https://mcp.example.com/mcp');
    expect(seen!.headers.get('authorization')).toBe('Bearer notes-upstream');
  });

  it('refuses an MCP server the agent is not allowed, without contacting it', async () => {
    const response = await handle(
      new Request('http://gw/mcp/secret_one', { method: 'POST', headers: { authorization: `Bearer ${token}` } }),
    );
    expect(response.status).toBe(403);
    expect(seen).toBeNull();
  });

  it('has no route for anything else', async () => {
    const response = await handle(
      new Request('http://gw/anything', { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(response.status).toBe(404);
  });
});

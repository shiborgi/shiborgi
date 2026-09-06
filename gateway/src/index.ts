/**
 * The gateway: this install's only route off the host.
 *
 * Agents run on a host-only network with no route to the internet. This
 * process is multi-homed — one leg on that network, one on a NAT network — so
 * it is the single hop between an agent and anything external. It answers two
 * surfaces:
 *
 *   POST /v1/*        OpenAI-compatible LLM traffic
 *   ALL  /mcp/<name>  a configured remote MCP server
 *   GET  /health/live liveness, used by the host before it spawns a session
 *
 * Three things it deliberately is NOT:
 *
 * - Not a cache. Every request goes upstream. A cache here would have to
 *   reason about model determinism and tool side effects to be correct, and a
 *   wrong hit is indistinguishable from a model that changed its mind.
 * - Not an MCP host. It routes to MCP SERVERS over HTTP and never spawns a
 *   stdio one. A stdio server would run inside this container, inheriting its
 *   egress — which is exactly the boundary this process exists to be.
 * - Not a credential broker for agents. It never returns a credential in a
 *   response body, and never accepts one in a request.
 *
 * Streaming is pass-through: the upstream `Response.body` is returned as-is, so
 * SSE token deltas reach the agent as they arrive. Buffering here would make
 * every reply land at once after a long silence.
 */
import {
  allows,
  authHeader,
  loadConfig,
  policyFor,
  GatewayConfigError,
  type LoadedConfig,
} from './config.js';
import { bearerToken, verifyClientKey } from './identity.js';

const PORT = Number(process.env.GATEWAY_PORT ?? 8080);

/** Read per request, for the same reason the config paths are — see `config.ts`. */
function installSecret(): string {
  return process.env.NANOCLAW_GATEWAY_SECRET ?? '';
}

/**
 * Headers that describe the HOP, not the request, and must not be forwarded.
 * `authorization` is dropped because this gateway replaces it with the
 * upstream's own credential — forwarding the agent's identity token to a model
 * provider would leak it to a third party for no reason.
 */
const STRIPPED_REQUEST_HEADERS = new Set([
  'authorization',
  'host',
  'connection',
  'content-length',
  'accept-encoding',
  'x-api-key',
]);

const STRIPPED_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The error shape OpenAI-compatible clients know how to surface to a user. */
function apiError(status: number, message: string, type: string): Response {
  return json(status, { error: { message, type } });
}

function forwardableHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  return headers;
}

function forwardableResponse(upstream: Response): Response {
  const headers = new Headers();
  for (const [name, value] of upstream.headers) {
    if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  // Body is passed through unread so SSE streams arrive incrementally.
  return new Response(upstream.body, { status: upstream.status, headers });
}

/** Identify the caller, or explain why not. Never reveals whether an id exists. */
function authenticate(request: Request): { agentGroupId: string } | Response {
  const token = bearerToken(request.headers.get('authorization'));
  if (!token) {
    return apiError(401, 'Missing bearer token', 'authentication_error');
  }
  const agentGroupId = verifyClientKey(installSecret(), token);
  if (!agentGroupId) {
    return apiError(401, 'Invalid client key', 'authentication_error');
  }
  return { agentGroupId };
}

/**
 * The model alias a request asked for. Read from the body, which means the
 * body has to be buffered before forwarding — acceptable because a chat
 * request body is small and bounded, unlike the response it streams back.
 */
function requestedModel(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const model = (body as { model?: unknown }).model;
  return typeof model === 'string' && model.length > 0 ? model : null;
}

async function handleLlm(request: Request, url: URL, loaded: LoadedConfig, agentGroupId: string): Promise<Response> {
  const { config, secrets } = loaded;
  const policy = policyFor(config, agentGroupId);
  if (!policy) {
    return apiError(403, `No gateway policy for agent group ${agentGroupId}`, 'permission_error');
  }

  const raw = await request.text();
  let parsed: unknown = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return apiError(400, 'Request body is not valid JSON', 'invalid_request_error');
    }
  }

  const alias = requestedModel(parsed);
  if (!alias) {
    return apiError(400, 'Request does not name a model', 'invalid_request_error');
  }
  const route = config.models[alias];
  if (!route) {
    return apiError(404, `Model "${alias}" is not configured on this gateway`, 'invalid_request_error');
  }
  if (!allows(policy.models, alias)) {
    return apiError(403, `Agent group ${agentGroupId} may not use model "${alias}"`, 'permission_error');
  }
  const upstream = config.upstreams[route.upstream]!;

  // Rewrite the alias to the upstream's own model name. The agent keeps using
  // a stable local name while the operator repoints it in gateway.json.
  const body =
    route.model && parsed && typeof parsed === 'object'
      ? JSON.stringify({ ...(parsed as Record<string, unknown>), model: route.model })
      : raw;

  const headers = forwardableHeaders(request);
  const auth = authHeader(upstream.auth, secrets);
  if (auth) headers.set(auth.name, auth.value);

  // `/v1/chat/completions` under a baseUrl that already ends in `/v1` must not
  // become `/v1/v1/chat/completions`.
  const suffix = url.pathname.replace(/^\/v1/, '');
  const target = `${upstream.baseUrl}${suffix}${url.search}`;

  const response = await fetch(target, { method: request.method, headers, body: body || undefined });
  return forwardableResponse(response);
}

async function handleMcp(
  request: Request,
  url: URL,
  loaded: LoadedConfig,
  agentGroupId: string,
  name: string,
): Promise<Response> {
  const { config, secrets } = loaded;
  const policy = policyFor(config, agentGroupId);
  if (!policy) {
    return apiError(403, `No gateway policy for agent group ${agentGroupId}`, 'permission_error');
  }
  const route = config.mcpServers[name];
  if (!route) {
    return apiError(404, `MCP server "${name}" is not configured on this gateway`, 'invalid_request_error');
  }
  if (!allows(policy.mcpServers, name)) {
    return apiError(403, `Agent group ${agentGroupId} may not use MCP server "${name}"`, 'permission_error');
  }

  const headers = forwardableHeaders(request);
  const auth = authHeader(route.auth, secrets);
  if (auth) headers.set(auth.name, auth.value);

  const response = await fetch(`${route.url}${url.search}`, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
  });
  return forwardableResponse(response);
}

export async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // Liveness answers before authentication and before the config is read: the
  // host polls this to decide whether to spawn, and a gateway with a broken
  // policy file should report "up, misconfigured" through a real request
  // rather than look dead.
  if (url.pathname === '/health/live') {
    return new Response('ok', { headers: { 'content-type': 'text/plain' } });
  }

  if (!installSecret()) {
    return apiError(500, 'Gateway has no NANOCLAW_GATEWAY_SECRET; it cannot identify callers', 'api_error');
  }

  const identity = authenticate(request);
  if (identity instanceof Response) return identity;

  let loaded: LoadedConfig;
  try {
    loaded = await loadConfig();
  } catch (error) {
    const detail = error instanceof GatewayConfigError ? error.message : 'gateway configuration could not be read';
    return apiError(500, detail, 'api_error');
  }

  try {
    if (url.pathname.startsWith('/v1/')) {
      return await handleLlm(request, url, loaded, identity.agentGroupId);
    }
    const mcp = /^\/mcp\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
    if (mcp) {
      return await handleMcp(request, url, loaded, identity.agentGroupId, mcp[1]!);
    }
  } catch (error) {
    // A missing secret or an unreachable upstream is the operator's problem to
    // see, and the agent's to retry — but the detail must not carry a
    // credential, so only the message is surfaced.
    const detail = error instanceof GatewayConfigError ? error.message : 'upstream request failed';
    console.error('[gateway]', error);
    return apiError(502, detail, 'api_error');
  }

  return apiError(404, `No route for ${url.pathname}`, 'invalid_request_error');
}

if (import.meta.main) {
  Bun.serve({ port: PORT, hostname: '0.0.0.0', fetch: handle, idleTimeout: 240 });
  console.log(`[gateway] listening on :${PORT}`);
}

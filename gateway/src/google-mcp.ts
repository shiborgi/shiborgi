/**
 * The built-in Google MCP servers: Drive, Calendar and Tasks, served by the
 * gateway itself rather than proxied to a hosted endpoint.
 *
 * Why in-process. The gateway is already the only component holding a Google
 * refresh token, already routes `/mcp/<name>`, and already enforces which
 * agent group may reach which server. A separate container would need the
 * token shipped to it, a port, and a lifecycle — three new things to secure
 * for no capability the gateway lacks.
 *
 * The protocol surface is deliberately small: `initialize`, `tools/list`,
 * `tools/call`, and JSON-RPC errors for the rest. Clients that need SSE
 * streaming or sessions get neither, and say so in `initialize` rather than
 * failing later.
 */
import { callGoogle, DRIVE_API, DRIVE_UPLOAD_API, GoogleApiError, type Fetcher } from './google-api.js';
import { BUILTIN_TOOLS, type ToolDefinition } from './google-tools.js';

const PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function result(id: unknown, value: unknown): unknown {
  return { jsonrpc: '2.0', id: id ?? null, result: value };
}

function rpcError(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * A failed tool is `isError` inside a normal result, not a JSON-RPC error:
 * the model has to see what went wrong to choose its next call, and a
 * transport-level error is not surfaced to it as content.
 */
function toolFailure(id: unknown, message: string): unknown {
  return result(id, { content: [{ type: 'text', text: message }], isError: true });
}

function toolSuccess(id: unknown, value: unknown): unknown {
  return result(id, { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
}

/**
 * Drive splits reading in two and neither branch is knowable from the file id
 * alone: a Google-native doc must go through /export with a target MIME type,
 * and anything else through alt=media. Resolving the metadata first costs one
 * request and removes a guess the agent would otherwise get wrong half the
 * time.
 */
async function readDriveFile(
  accessToken: string,
  fileId: string,
  requestedMime: string | undefined,
  fetcher: Fetcher,
): Promise<unknown> {
  const meta = (await fetcher(accessToken, {
    method: 'GET',
    url: `${DRIVE_API}/files/${encodeURIComponent(fileId)}`,
    query: { fields: 'id,name,mimeType' },
  })) as { name?: string; mimeType?: string };

  const native = meta.mimeType?.startsWith('application/vnd.google-apps.');
  if (!native) {
    const body = await fetcher(accessToken, {
      method: 'GET',
      url: `${DRIVE_API}/files/${encodeURIComponent(fileId)}`,
      query: { alt: 'media' },
    });
    return { name: meta.name, mimeType: meta.mimeType, content: body };
  }

  const exportMime =
    requestedMime ?? (meta.mimeType === 'application/vnd.google-apps.spreadsheet' ? 'text/csv' : 'text/plain');
  const body = await fetcher(accessToken, {
    method: 'GET',
    url: `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export`,
    query: { mimeType: exportMime },
  });
  return { name: meta.name, mimeType: meta.mimeType, exportedAs: exportMime, content: body };
}

/**
 * Creating a file is metadata then bytes. Drive's multipart upload would do it
 * in one round trip, but composing that body by hand is a boundary-string bug
 * waiting to happen; two plain requests are the same result with nothing to
 * get subtly wrong.
 */
async function createDriveFile(
  accessToken: string,
  args: Record<string, unknown>,
  definition: ToolDefinition,
  fetcher: Fetcher,
): Promise<unknown> {
  const created = (await fetcher(accessToken, definition.request(args))) as { id?: string };
  if (!created.id) throw new GoogleApiError('Drive did not return a file id', 502);
  const updated = await fetcher(accessToken, {
    method: 'PATCH',
    url: `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(created.id)}`,
    query: { uploadType: 'media', fields: 'id,name,mimeType,webViewLink' },
    body: String(args.content ?? ''),
  });
  return updated;
}

export interface BuiltinMcpOptions {
  /** Resolves the Google access token for this route's OAuth profile. */
  accessToken: () => Promise<string>;
  /** Injected in tests; defaults to the real REST client. */
  fetcher?: Fetcher;
}

/**
 * Handle one JSON-RPC message for a built-in server. Returns the response
 * object, or null for a notification (which takes 202 with no body).
 */
export async function handleBuiltinMcp(
  serverName: string,
  message: JsonRpcRequest,
  options: BuiltinMcpOptions,
): Promise<unknown | null> {
  const tools = BUILTIN_TOOLS[serverName];
  if (!tools) return rpcError(message.id, -32601, `Unknown built-in MCP server "${serverName}"`);

  const method = typeof message.method === 'string' ? message.method : '';
  // A notification carries no id and expects no response; `initialized` is the
  // one every client sends right after the handshake.
  if (method.startsWith('notifications/')) return null;

  if (method === 'initialize') {
    return result(message.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: serverName, version: '1.0.0' },
    });
  }

  if (method === 'tools/list') {
    return result(message.id, {
      tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    });
  }

  if (method !== 'tools/call') {
    return rpcError(message.id, -32601, `Method "${method}" is not supported by this server`);
  }

  const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
  const toolName = typeof params.name === 'string' ? params.name : '';
  const definition = tools.find((tool) => tool.name === toolName);
  if (!definition) return toolFailure(message.id, `Unknown tool "${toolName}" on ${serverName}`);

  const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<
    string,
    unknown
  >;
  const fetcher = options.fetcher ?? callGoogle;

  try {
    const accessToken = await options.accessToken();

    if (serverName === 'google-drive' && toolName === 'read_file_content') {
      const fileId = typeof args.fileId === 'string' ? args.fileId : '';
      if (!fileId) return toolFailure(message.id, '"fileId" is required');
      return toolSuccess(
        message.id,
        await readDriveFile(accessToken, fileId, typeof args.mimeType === 'string' ? args.mimeType : undefined, fetcher),
      );
    }
    if (serverName === 'google-drive' && toolName === 'create_file') {
      return toolSuccess(message.id, await createDriveFile(accessToken, args, definition, fetcher));
    }

    return toolSuccess(message.id, await fetcher(accessToken, definition.request(args)));
    // eslint-disable-next-line no-catch-all/no-catch-all -- every failure here is the tool's answer
  } catch (err) {
    // Argument and API failures both belong in the tool result: the model reads
    // the message and retries or reports, which a transport error would deny it.
    return toolFailure(message.id, err instanceof Error ? err.message : String(err));
  }
}

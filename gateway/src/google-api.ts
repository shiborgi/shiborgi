/**
 * The REST half of the built-in Google MCP servers.
 *
 * Google publishes hosted MCP servers for Drive and Calendar, but they sit
 * behind the Workspace Developer Preview Program: a project not enrolled gets
 * "Access to this tool requires that your Google Cloud project is enrolled",
 * and Tasks has no hosted MCP at all. The REST APIs underneath have been
 * generally available for years, so the built-ins call those directly.
 *
 * No credential lives here. The access token arrives per call from the
 * gateway's OAuth profile, which is the only thing that holds a refresh token
 * — so a bug in this file cannot leak one, and a token cannot outlive the
 * request it was fetched for.
 */

/** A Google API error the caller should see, already stripped of internals. */
export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

export interface GoogleRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  /** Query parameters; undefined values are dropped rather than sent empty. */
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

/** Injected so tests drive the tool surface without reaching the network. */
export type Fetcher = (accessToken: string, request: GoogleRequest) => Promise<unknown>;

function buildUrl(request: GoogleRequest): string {
  const url = new URL(request.url);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Google's error envelope is `{ error: { message, status } }`, but an
 * unauthenticated or proxied failure can return HTML or an empty body. Reading
 * the message when it exists and falling back to the status keeps the tool
 * result actionable either way — the agent is told what went wrong, not handed
 * a parse error about the error.
 */
export async function callGoogle(accessToken: string, request: GoogleRequest): Promise<unknown> {
  const response = await fetch(buildUrl(request), {
    method: request.method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await response.text();
  if (!response.ok) {
    let message = `Google API returned ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === 'string') message = parsed.error.message;
    } catch {
      // Not JSON — the status line is the whole story.
    }
    throw new GoogleApiError(message, response.status);
  }
  // 204 on delete, and an empty body is a valid success there.
  if (!text) return { ok: true };

  // A non-JSON body is not an error here — it is the point. `alt=media` and
  // `/export` return the file itself, so a CSV, a plain-text note or an
  // exported Doc all arrive as text, and parsing them would fail on content
  // the caller specifically asked for. Only a body Google labels as JSON is
  // parsed; everything else is handed back verbatim.
  if (!(response.headers.get('content-type') ?? '').includes('json')) return text;
  try {
    return JSON.parse(text);
  } catch {
    throw new GoogleApiError('Google API returned a malformed JSON body', response.status);
  }
}

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
export const TASKS_API = 'https://tasks.googleapis.com/tasks/v1';

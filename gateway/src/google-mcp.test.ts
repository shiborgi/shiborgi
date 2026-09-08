/**
 * The built-in Google servers, driven through the same entry the gateway uses.
 *
 * What matters here is not that a request object is well formed — it is that
 * the shape an agent is told to send produces the call Google actually wants.
 * The failures these guard are the ones an agent cannot diagnose: an all-day
 * event sent as a date-time, a native Doc read as raw bytes, a tool error
 * delivered as a transport error the model never sees.
 */
import { describe, expect, it } from 'bun:test';

import { GoogleApiError, type Fetcher, type GoogleRequest } from './google-api.js';
import { handleBuiltinMcp } from './google-mcp.js';
import { BUILTIN_TOOLS } from './google-tools.js';

const token = async (): Promise<string> => 'test-access-token';

/** Records every call and returns a canned body per call index. */
function recorder(bodies: unknown[] = [{}]): { calls: GoogleRequest[]; tokens: string[]; fetcher: Fetcher } {
  const calls: GoogleRequest[] = [];
  const tokens: string[] = [];
  const fetcher: Fetcher = async (accessToken, request) => {
    tokens.push(accessToken);
    calls.push(request);
    return bodies[calls.length - 1] ?? {};
  };
  return { calls, tokens, fetcher };
}

async function call(server: string, name: string, args: Record<string, unknown>, fetcher: Fetcher): Promise<any> {
  return handleBuiltinMcp(
    server,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { accessToken: token, fetcher },
  );
}

describe('protocol surface', () => {
  it('answers initialize with the server name', async () => {
    const res: any = await handleBuiltinMcp('google-tasks', { id: 1, method: 'initialize' }, { accessToken: token });
    expect(res.result.serverInfo.name).toBe('google-tasks');
    expect(res.result.capabilities.tools).toBeDefined();
  });

  it('lists every tool with a schema', async () => {
    for (const [server, tools] of Object.entries(BUILTIN_TOOLS)) {
      const res: any = await handleBuiltinMcp(server, { id: 1, method: 'tools/list' }, { accessToken: token });
      expect(res.result.tools).toHaveLength(tools.length);
      for (const tool of res.result.tools) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema.type).toBe('object');
      }
    }
  });

  it('returns nothing for a notification, so the caller can send 202', async () => {
    const res = await handleBuiltinMcp(
      'google-drive',
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { accessToken: token },
    );
    expect(res).toBeNull();
  });

  it('rejects an unknown server and an unsupported method', async () => {
    const bad: any = await handleBuiltinMcp('google-photos', { id: 1, method: 'initialize' }, { accessToken: token });
    expect(bad.error.code).toBe(-32601);
    const method: any = await handleBuiltinMcp('google-drive', { id: 2, method: 'resources/list' }, { accessToken: token });
    expect(method.error.code).toBe(-32601);
  });
});

describe('calendar', () => {
  /*
   * Calendar takes `date` for all-day and `dateTime` for timed events and
   * rejects the wrong key. The agent only ever signals which it means by the
   * shape of the string it passes, so this mapping is the whole contract.
   */
  it('sends a bare date as an all-day event and a timestamp as a timed one', async () => {
    const { calls, fetcher } = recorder();
    await call('google-calendar', 'create_event', { summary: 'Holiday', start: '2026-09-10', end: '2026-09-11' }, fetcher);
    expect((calls[0]!.body as any).start).toEqual({ date: '2026-09-10' });

    const timed = recorder();
    await call(
      'google-calendar',
      'create_event',
      { summary: 'Standup', start: '2026-09-10T09:00:00Z', end: '2026-09-10T09:15:00Z' },
      timed.fetcher,
    );
    expect((timed.calls[0]!.body as any).start).toEqual({ dateTime: '2026-09-10T09:00:00Z' });
  });

  it('expands attendee emails into the objects the API expects', async () => {
    const { calls, fetcher } = recorder();
    await call(
      'google-calendar',
      'create_event',
      { summary: 'Review', start: '2026-09-10T09:00:00Z', end: '2026-09-10T10:00:00Z', attendees: ['a@x.test', 'b@x.test'] },
      fetcher,
    );
    expect((calls[0]!.body as any).attendees).toEqual([{ email: 'a@x.test' }, { email: 'b@x.test' }]);
  });

  it('defaults to the primary calendar and expands recurrences in order', async () => {
    const { calls, fetcher } = recorder();
    await call('google-calendar', 'list_events', {}, fetcher);
    expect(calls[0]!.url).toContain('/calendars/primary/events');
    expect(calls[0]!.query).toMatchObject({ singleEvents: true, orderBy: 'startTime' });
  });

  it('sends only the fields an update names', async () => {
    const { calls, fetcher } = recorder();
    await call('google-calendar', 'update_event', { eventId: 'e1', summary: 'Renamed' }, fetcher);
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.body).toEqual({ summary: 'Renamed' });
  });
});

describe('drive', () => {
  /*
   * A Google-native doc has no bytes to download: alt=media returns 403 and
   * the agent is told "permission", which sends it looking in the wrong place.
   * Resolving the type first is what turns that into a working read.
   */
  it('exports a native Doc as text instead of downloading it', async () => {
    const { calls, fetcher } = recorder([
      { id: 'f1', name: 'Notes', mimeType: 'application/vnd.google-apps.document' },
      'the body',
    ]);
    const res: any = await call('google-drive', 'read_file_content', { fileId: 'f1' }, fetcher);
    expect(calls[1]!.url).toContain('/export');
    expect(calls[1]!.query).toMatchObject({ mimeType: 'text/plain' });
    expect(res.result.isError).toBeUndefined();
  });

  it('exports a native Sheet as CSV, where text/plain would lose the columns', async () => {
    const { calls, fetcher } = recorder([{ id: 'f2', mimeType: 'application/vnd.google-apps.spreadsheet' }, 'a,b']);
    await call('google-drive', 'read_file_content', { fileId: 'f2' }, fetcher);
    expect(calls[1]!.query).toMatchObject({ mimeType: 'text/csv' });
  });

  it('downloads a non-native file as media', async () => {
    const { calls, fetcher } = recorder([{ id: 'f3', mimeType: 'text/plain' }, 'plain body']);
    await call('google-drive', 'read_file_content', { fileId: 'f3' }, fetcher);
    expect(calls[1]!.query).toMatchObject({ alt: 'media' });
    expect(calls[1]!.url).not.toContain('/export');
  });

  it('creates a file as metadata then bytes', async () => {
    const { calls, fetcher } = recorder([{ id: 'new1' }, { id: 'new1', name: 'a.txt' }]);
    await call('google-drive', 'create_file', { name: 'a.txt', content: 'hello' }, fetcher);
    expect(calls[0]!.method).toBe('POST');
    expect((calls[0]!.body as any).name).toBe('a.txt');
    expect(calls[1]!.method).toBe('PATCH');
    expect(calls[1]!.query).toMatchObject({ uploadType: 'media' });
    expect(calls[1]!.body).toBe('hello');
  });

  it('caps an oversized pageSize rather than letting Google reject it', async () => {
    const { calls, fetcher } = recorder();
    await call('google-drive', 'search_files', { query: "name contains 'x'", pageSize: 5000 }, fetcher);
    expect(calls[0]!.query!.pageSize).toBe(100);
  });
});

describe('tasks', () => {
  it('uses the default list and hides completed tasks unless asked', async () => {
    const { calls, fetcher } = recorder();
    await call('google-tasks', 'list_tasks', {}, fetcher);
    expect(calls[0]!.url).toContain('/lists/%40default/tasks');
    expect(calls[0]!.query).toMatchObject({ showCompleted: false });

    const shown = recorder();
    await call('google-tasks', 'list_tasks', { showCompleted: true }, shown.fetcher);
    expect(shown.calls[0]!.query).toMatchObject({ showCompleted: true, showHidden: true });
  });

  it('completes a task through status rather than a separate verb', async () => {
    const { calls, fetcher } = recorder();
    await call('google-tasks', 'update_task', { taskId: 't1', status: 'completed' }, fetcher);
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.body).toEqual({ status: 'completed' });
  });
});

describe('failures reach the model as tool results', () => {
  it('reports a missing required argument without calling Google', async () => {
    const { calls, fetcher } = recorder();
    const res: any = await call('google-calendar', 'get_event', {}, fetcher);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('"eventId" is required');
    expect(calls).toHaveLength(0);
  });

  it('passes a Google error message through instead of a transport failure', async () => {
    const failing: Fetcher = async () => {
      throw new GoogleApiError('Calendar usage limits exceeded', 403);
    };
    const res: any = await call('google-calendar', 'list_calendars', {}, failing);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toBe('Calendar usage limits exceeded');
    expect(res.error).toBeUndefined();
  });

  it('names an unknown tool rather than silently doing nothing', async () => {
    const { fetcher } = recorder();
    const res: any = await call('google-tasks', 'delete_everything', {}, fetcher);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('delete_everything');
  });
});

describe('the access token', () => {
  it('is fetched per call and reaches every request', async () => {
    const { tokens, fetcher } = recorder([{ id: 'f1', mimeType: 'text/plain' }, 'body']);
    await call('google-drive', 'read_file_content', { fileId: 'f1' }, fetcher);
    expect(tokens).toEqual(['test-access-token', 'test-access-token']);
  });
});

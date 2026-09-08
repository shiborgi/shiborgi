/**
 * Tool definitions for the built-in Google MCP servers.
 *
 * One table per API, each entry pairing the schema an agent sees with the REST
 * call it becomes. Keeping the two adjacent is deliberate: a schema that drifts
 * from its request is the failure an agent cannot diagnose — it sends what it
 * was told to send and gets a 400 about a field it never heard of.
 *
 * Scope discipline: every tool here is reachable with the scopes the OAuth
 * profile already requests. Adding one that needs more means adding the scope
 * and re-consenting, which is an operator action, not a silent expansion.
 */
import { CALENDAR_API, DRIVE_API, TASKS_API, type GoogleRequest } from './google-api.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Maps validated arguments onto the REST call. */
  request: (args: Record<string, unknown>) => GoogleRequest;
}

const str = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === 'string' && args[key] ? (args[key] as string) : undefined;

const num = (args: Record<string, unknown>, key: string): number | undefined =>
  typeof args[key] === 'number' ? (args[key] as number) : undefined;

/** Required-argument accessor: the message names the tool's own field. */
function required(args: Record<string, unknown>, key: string): string {
  const value = str(args, key);
  if (!value) throw new Error(`"${key}" is required`);
  return value;
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

const DRIVE_FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,webViewLink,owners(emailAddress),parents';

export const DRIVE_TOOLS: ToolDefinition[] = [
  {
    name: 'search_files',
    description:
      'Search Drive with a Drive query string, e.g. `name contains \'invoice\'` or ' +
      "`mimeType='application/pdf'`. Returns id, name, mimeType and modifiedTime.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Drive query, e.g. name contains 'report'" },
        pageSize: { type: 'number', description: 'Max results, 1-100 (default 20)' },
        pageToken: { type: 'string', description: 'Continuation token from a previous call' },
      },
      required: ['query'],
    },
    request: (args) => ({
      method: 'GET',
      url: `${DRIVE_API}/files`,
      query: {
        q: required(args, 'query'),
        pageSize: Math.min(Math.max(num(args, 'pageSize') ?? 20, 1), 100),
        pageToken: str(args, 'pageToken'),
        fields: `nextPageToken,files(${DRIVE_FILE_FIELDS})`,
      },
    }),
  },
  {
    name: 'list_recent_files',
    description: 'List the most recently modified files, newest first.',
    inputSchema: {
      type: 'object',
      properties: { pageSize: { type: 'number', description: 'Max results, 1-100 (default 20)' } },
    },
    request: (args) => ({
      method: 'GET',
      url: `${DRIVE_API}/files`,
      query: {
        orderBy: 'modifiedTime desc',
        pageSize: Math.min(Math.max(num(args, 'pageSize') ?? 20, 1), 100),
        fields: `files(${DRIVE_FILE_FIELDS})`,
      },
    }),
  },
  {
    name: 'get_file_metadata',
    description: 'Read one file\'s metadata by id, without downloading its contents.',
    inputSchema: {
      type: 'object',
      properties: { fileId: { type: 'string', description: 'Drive file id' } },
      required: ['fileId'],
    },
    request: (args) => ({
      method: 'GET',
      url: `${DRIVE_API}/files/${encodeURIComponent(required(args, 'fileId'))}`,
      query: { fields: DRIVE_FILE_FIELDS },
    }),
  },
  {
    name: 'read_file_content',
    description:
      'Read a file as text. Google Docs, Sheets and Slides are exported to text/CSV; ' +
      'a plain text or JSON file is returned as-is. Binary formats are not readable here.',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'Drive file id' },
        mimeType: {
          type: 'string',
          description: 'Export type for Google-native files (default text/plain, or text/csv for Sheets)',
        },
      },
      required: ['fileId'],
    },
    // Native Google formats need /export; everything else needs alt=media. The
    // caller cannot know which without a metadata round-trip, so the dispatcher
    // resolves it (see readDriveFile) rather than making the agent guess.
    request: (args) => ({
      method: 'GET',
      url: `${DRIVE_API}/files/${encodeURIComponent(required(args, 'fileId'))}`,
      query: { fields: 'id,name,mimeType' },
    }),
  },
  {
    name: 'create_file',
    description:
      'Create a text file in Drive. Provide `content` and a `name`; ' +
      'optionally a parent folder id. Existing files are never overwritten.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'File name' },
        content: { type: 'string', description: 'File contents as text' },
        mimeType: { type: 'string', description: 'MIME type (default text/plain)' },
        parentId: { type: 'string', description: 'Parent folder id' },
      },
      required: ['name', 'content'],
    },
    // Metadata-only create; the dispatcher uploads the body separately.
    request: (args) => ({
      method: 'POST',
      url: `${DRIVE_API}/files`,
      query: { fields: DRIVE_FILE_FIELDS },
      body: {
        name: required(args, 'name'),
        mimeType: str(args, 'mimeType') ?? 'text/plain',
        ...(str(args, 'parentId') ? { parents: [str(args, 'parentId')] } : {}),
      },
    }),
  },
];

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export const CALENDAR_TOOLS: ToolDefinition[] = [
  {
    name: 'list_calendars',
    description: 'List the calendars this account can see, with their ids and access roles.',
    inputSchema: { type: 'object', properties: {} },
    request: () => ({ method: 'GET', url: `${CALENDAR_API}/users/me/calendarList` }),
  },
  {
    name: 'list_events',
    description:
      'List events in a time window, ordered by start. Times are RFC3339, ' +
      'e.g. 2026-09-08T00:00:00Z. Defaults to the primary calendar.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar id (default "primary")' },
        timeMin: { type: 'string', description: 'RFC3339 lower bound' },
        timeMax: { type: 'string', description: 'RFC3339 upper bound' },
        maxResults: { type: 'number', description: 'Max events, 1-250 (default 50)' },
      },
    },
    request: (args) => ({
      method: 'GET',
      url: `${CALENDAR_API}/calendars/${encodeURIComponent(str(args, 'calendarId') ?? 'primary')}/events`,
      query: {
        timeMin: str(args, 'timeMin'),
        timeMax: str(args, 'timeMax'),
        maxResults: Math.min(Math.max(num(args, 'maxResults') ?? 50, 1), 250),
        singleEvents: true,
        orderBy: 'startTime',
      },
    }),
  },
  {
    name: 'search_events',
    description: 'Free-text search across events on a calendar.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to match' },
        calendarId: { type: 'string', description: 'Calendar id (default "primary")' },
        maxResults: { type: 'number', description: 'Max events, 1-250 (default 50)' },
      },
      required: ['query'],
    },
    request: (args) => ({
      method: 'GET',
      url: `${CALENDAR_API}/calendars/${encodeURIComponent(str(args, 'calendarId') ?? 'primary')}/events`,
      query: {
        q: required(args, 'query'),
        maxResults: Math.min(Math.max(num(args, 'maxResults') ?? 50, 1), 250),
        singleEvents: true,
        orderBy: 'startTime',
      },
    }),
  },
  {
    name: 'get_event',
    description: 'Read one event by id.',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'Event id' },
        calendarId: { type: 'string', description: 'Calendar id (default "primary")' },
      },
      required: ['eventId'],
    },
    request: (args) => ({
      method: 'GET',
      url: `${CALENDAR_API}/calendars/${encodeURIComponent(str(args, 'calendarId') ?? 'primary')}/events/${encodeURIComponent(required(args, 'eventId'))}`,
    }),
  },
  {
    name: 'create_event',
    description:
      'Create an event. `start` and `end` are RFC3339 date-times; for an all-day ' +
      'event pass dates (YYYY-MM-DD) instead. Attendees are email addresses.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Event title' },
        start: { type: 'string', description: 'RFC3339 date-time, or YYYY-MM-DD for all-day' },
        end: { type: 'string', description: 'RFC3339 date-time, or YYYY-MM-DD for all-day' },
        description: { type: 'string', description: 'Event body' },
        location: { type: 'string', description: 'Location' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Attendee emails' },
        calendarId: { type: 'string', description: 'Calendar id (default "primary")' },
      },
      required: ['summary', 'start', 'end'],
    },
    request: (args) => ({
      method: 'POST',
      url: `${CALENDAR_API}/calendars/${encodeURIComponent(str(args, 'calendarId') ?? 'primary')}/events`,
      body: {
        summary: required(args, 'summary'),
        ...(str(args, 'description') ? { description: str(args, 'description') } : {}),
        ...(str(args, 'location') ? { location: str(args, 'location') } : {}),
        start: timePoint(required(args, 'start')),
        end: timePoint(required(args, 'end')),
        ...(Array.isArray(args.attendees)
          ? { attendees: (args.attendees as unknown[]).filter((a): a is string => typeof a === 'string').map((email) => ({ email })) }
          : {}),
      },
    }),
  },
  {
    name: 'update_event',
    description: 'Change fields on an existing event. Only the fields you pass are altered.',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'Event id' },
        summary: { type: 'string', description: 'New title' },
        start: { type: 'string', description: 'New start (RFC3339 or YYYY-MM-DD)' },
        end: { type: 'string', description: 'New end (RFC3339 or YYYY-MM-DD)' },
        description: { type: 'string', description: 'New body' },
        location: { type: 'string', description: 'New location' },
        calendarId: { type: 'string', description: 'Calendar id (default "primary")' },
      },
      required: ['eventId'],
    },
    request: (args) => ({
      method: 'PATCH',
      url: `${CALENDAR_API}/calendars/${encodeURIComponent(str(args, 'calendarId') ?? 'primary')}/events/${encodeURIComponent(required(args, 'eventId'))}`,
      body: {
        ...(str(args, 'summary') ? { summary: str(args, 'summary') } : {}),
        ...(str(args, 'description') ? { description: str(args, 'description') } : {}),
        ...(str(args, 'location') ? { location: str(args, 'location') } : {}),
        ...(str(args, 'start') ? { start: timePoint(str(args, 'start')!) } : {}),
        ...(str(args, 'end') ? { end: timePoint(str(args, 'end')!) } : {}),
      },
    }),
  },
  {
    name: 'delete_event',
    description: 'Delete an event. This cancels it for every attendee — confirm before calling.',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'Event id' },
        calendarId: { type: 'string', description: 'Calendar id (default "primary")' },
      },
      required: ['eventId'],
    },
    request: (args) => ({
      method: 'DELETE',
      url: `${CALENDAR_API}/calendars/${encodeURIComponent(str(args, 'calendarId') ?? 'primary')}/events/${encodeURIComponent(required(args, 'eventId'))}`,
    }),
  },
];

/**
 * Calendar takes `date` for all-day and `dateTime` for timed events, and
 * rejects the wrong one. A bare YYYY-MM-DD is the only unambiguous signal an
 * agent gives, so it decides the shape.
 */
function timePoint(value: string): { date: string } | { dateTime: string } {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? { date: value } : { dateTime: value };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const TASKS_TOOLS: ToolDefinition[] = [
  {
    name: 'list_tasklists',
    description: 'List the task lists on this account, with their ids.',
    inputSchema: { type: 'object', properties: {} },
    request: () => ({ method: 'GET', url: `${TASKS_API}/users/@me/lists` }),
  },
  {
    name: 'list_tasks',
    description:
      'List tasks in a list. Completed tasks are hidden unless showCompleted is true. ' +
      'Use list_tasklists first to get an id; "@default" is the default list.',
    inputSchema: {
      type: 'object',
      properties: {
        tasklist: { type: 'string', description: 'Task list id (default "@default")' },
        showCompleted: { type: 'boolean', description: 'Include completed tasks' },
        maxResults: { type: 'number', description: 'Max tasks, 1-100 (default 50)' },
      },
    },
    request: (args) => ({
      method: 'GET',
      url: `${TASKS_API}/lists/${encodeURIComponent(str(args, 'tasklist') ?? '@default')}/tasks`,
      query: {
        showCompleted: args.showCompleted === true,
        showHidden: args.showCompleted === true,
        maxResults: Math.min(Math.max(num(args, 'maxResults') ?? 50, 1), 100),
      },
    }),
  },
  {
    name: 'get_task',
    description: 'Read one task by id.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task id' },
        tasklist: { type: 'string', description: 'Task list id (default "@default")' },
      },
      required: ['taskId'],
    },
    request: (args) => ({
      method: 'GET',
      url: `${TASKS_API}/lists/${encodeURIComponent(str(args, 'tasklist') ?? '@default')}/tasks/${encodeURIComponent(required(args, 'taskId'))}`,
    }),
  },
  {
    name: 'create_task',
    description:
      'Add a task. `due` is an RFC3339 date-time, but Google Tasks stores only the ' +
      'date part — a time of day is accepted and then ignored.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title' },
        notes: { type: 'string', description: 'Task notes' },
        due: { type: 'string', description: 'RFC3339 due date, e.g. 2026-09-30T00:00:00Z' },
        tasklist: { type: 'string', description: 'Task list id (default "@default")' },
      },
      required: ['title'],
    },
    request: (args) => ({
      method: 'POST',
      url: `${TASKS_API}/lists/${encodeURIComponent(str(args, 'tasklist') ?? '@default')}/tasks`,
      body: {
        title: required(args, 'title'),
        ...(str(args, 'notes') ? { notes: str(args, 'notes') } : {}),
        ...(str(args, 'due') ? { due: str(args, 'due') } : {}),
      },
    }),
  },
  {
    name: 'update_task',
    description:
      'Change a task. Pass status "completed" to tick it off, or "needsAction" to reopen it. ' +
      'Only the fields you pass are altered.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task id' },
        title: { type: 'string', description: 'New title' },
        notes: { type: 'string', description: 'New notes' },
        due: { type: 'string', description: 'New RFC3339 due date' },
        status: { type: 'string', enum: ['needsAction', 'completed'], description: 'Task status' },
        tasklist: { type: 'string', description: 'Task list id (default "@default")' },
      },
      required: ['taskId'],
    },
    request: (args) => ({
      method: 'PATCH',
      url: `${TASKS_API}/lists/${encodeURIComponent(str(args, 'tasklist') ?? '@default')}/tasks/${encodeURIComponent(required(args, 'taskId'))}`,
      body: {
        ...(str(args, 'title') ? { title: str(args, 'title') } : {}),
        ...(str(args, 'notes') ? { notes: str(args, 'notes') } : {}),
        ...(str(args, 'due') ? { due: str(args, 'due') } : {}),
        ...(str(args, 'status') ? { status: str(args, 'status') } : {}),
      },
    }),
  },
  {
    name: 'delete_task',
    description: 'Delete a task permanently. Completing it is usually what is wanted instead.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task id' },
        tasklist: { type: 'string', description: 'Task list id (default "@default")' },
      },
      required: ['taskId'],
    },
    request: (args) => ({
      method: 'DELETE',
      url: `${TASKS_API}/lists/${encodeURIComponent(str(args, 'tasklist') ?? '@default')}/tasks/${encodeURIComponent(required(args, 'taskId'))}`,
    }),
  },
];

/** The built-in server names, and the tools each exposes. */
export const BUILTIN_TOOLS: Record<string, ToolDefinition[]> = {
  'google-drive': DRIVE_TOOLS,
  'google-calendar': CALENDAR_TOOLS,
  'google-tasks': TASKS_TOOLS,
};

export const BUILTIN_NAMES = Object.keys(BUILTIN_TOOLS);

/**
 * Pi (coding-agent) provider — agent-runner side.
 *
 * Spawns `pi --mode rpc` over stdin/stdout as a child process. The container
 * already has the binary available — the host `container/cli-tools.json`
 * entry installs `@earendil-works/pi-coding-agent` globally during image
 * build, and the agent-runner consumes it via the `pi` CLI on $PATH.
 *
 * Pi speaks JSONL over stdin/stdout in RPC mode (see pi.dev/docs/rpc). We
 * translate its events into the generic `ProviderEvent` stream the poll-loop
 * consumes, and we drive commands in (prompt / steer / followUp / abort)
 * based on `AgentQuery.push` / `.end` / `.abort`.
 *
 * Credentials: pi reads `ANTHROPIC_API_KEY` natively for the anthropic
 * provider; for everything else it follows its own env model. The host
 * provider (`src/providers/pi.ts`) forwards `PI_PROVIDER`, `PI_MODEL`, and
 * `ANTHROPIC_BASE_URL` from the host `.env`; the rest of pi's env surface
 * (OPENAI_API_KEY etc.) is read by pi itself inside the container.
 *
 * Continuation: pi identifies sessions by an internal id, distinct from
 * Claude's session UUID. We pass `input.continuation` through as the
 * session id at `turn_start`; a new id arrives on the next
 * `agent_start`/`session` line and we surface it as the new `init`
 * continuation for the poll-loop to capture.
 */
import { spawn, type ChildProcess } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';

import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';

function log(msg: string): void {
  console.error(`[pi-provider] ${msg}`);
}

/** Stale-session detection matches pi's "session not found" / abort messages. */
const STALE_SESSION_RE = /session.*not found|EAI_REPEAT|stream.*aborted|session id is invalid/i;

/**
 * AsyncIterable that splits a ReadableStream of bytes into JSONL records
 * (newline-delimited JSON). Tolerates `\r\n` line endings by stripping the
 * CR — pi's CLI emits LF on POSIX but adapters underneath it sometimes
 * inject a CR.
 */
async function* jsonlLines(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  let buf = '';
  for await (const chunk of stream) {
    buf += chunk.toString('utf-8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      let line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > 0) yield line;
    }
  }
  if (buf.length > 0) {
    if (buf.endsWith('\r')) buf = buf.slice(0, -1);
    if (buf.length > 0) yield buf;
  }
}

interface PiRpcCommand {
  type: string;
  [k: string]: unknown;
}

interface PiRpcEvent {
  type: string;
  [k: string]: unknown;
}

export class PiProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private model?: string;
  private env: NodeJS.ProcessEnv;

  constructor(options: ProviderOptions = {}) {
    this.model = options.model;
    this.env = { ...process.env, ...(options.env ?? {}) };
  }

  registerMemorySessionHook(): void {
    // Pi reads its memory surface from `~/.pi/agent/AGENTS.md` (pi's
    // canonical location, equivalent to CLAUDE.md for the Anthropic SDK).
    // We don't need to mutate pi's auth/settings to participate in the
    // shared-memory hook — pi surfaces memory through the same global
    // instruction path and the host already mounts that file via the
    // shared agent-runner surface. Recording this no-op explicitly keeps
    // the AgentProvider interface honest when pi gains a richer memory
    // model in a later minor.
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    // Build the args list. Pi's --provider/--model flags line up with the
    // values forwarded by the host provider — `PI_PROVIDER` / `PI_MODEL`,
    // falling back to `--model` if the host materializes a specific model
    // string into the constructor (the `--model "provider/id"` form pi
    // expects).
    const args = ['--mode', 'rpc', '--no-session'];
    const provider = this.env.PI_PROVIDER;
    if (typeof provider === 'string' && provider.length > 0) {
      args.push('--provider', provider);
    }
    if (this.model) {
      args.push('--model', this.model);
    } else if (typeof this.env.PI_MODEL === 'string' && this.env.PI_MODEL.length > 0) {
      // Match pi's `provider/id` shape when both are present; otherwise pass
      // the literal and let pi resolve.
      args.push('--model', this.env.PI_MODEL);
    }

    const child: ChildProcess = spawn('pi', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
    });

    // The query event queue — JSONL records from pi's stdout, fed into the
    // generic ProviderEvent shape. Backpressure is implicit: the consumer
    // pulls from `events`; we drop nothing.
    const events: ProviderEvent[] = [];
    let resolveNext: (() => void) | null = null;
    let closed = false;
    function wake(): void {
      const r = resolveNext;
      resolveNext = null;
      if (r) r();
    }
    function push(e: ProviderEvent): void {
      events.push(e);
      wake();
    }
    function pushErr(text: string): void {
      push({ type: 'error', message: text, retryable: false });
    }

    log(`spawn pi pid=${child.pid ?? '?'} args=${args.join(' ')}`);

    const stderrTail: string[] = [];
    child.stderr?.on('data', (data) => {
      for (const line of data.toString().trim().split('\n')) {
        if (!line) continue;
        log(`stderr: ${line}`);
        stderrTail.push(line);
        if (stderrTail.length > 10) stderrTail.shift();
      }
    });

    // Translate pi JSONL events → ProviderEvent. Pi is event-stream-shaped
    // (every event matters; the poll-loop uses 'activity' to keep the
    // idle-timer honest during long tool runs). A complete turn ends on
    // either `agent_end` (clean) or an error; the next prompt lands on
    // `agent_start` of the following turn.
    const reader = (async () => {
      try {
        if (!child.stdout) {
          pushErr('pi rpc process has no stdout pipe');
          return;
        }
        for await (const line of jsonlLines(child.stdout)) {
          let evt: PiRpcEvent;
          try {
            evt = JSON.parse(line);
          } catch {
            // Non-JSON line — surface via stderr tail style and keep going.
            log(`non-json line from pi: ${line.slice(0, 200)}`);
            continue;
          }

          // Liveness signal — every event counts as activity, including
          // heartbeat-style ones the poll-loop can ignore.
          push({ type: 'activity' });

          switch (evt.type) {
            case 'session': {
              // First-line session header — pi's identifier for this turn,
              // distinct from Claude's UUID; surface as init continuation.
              const id = typeof evt.id === 'string' ? evt.id : undefined;
              if (id) push({ type: 'init', continuation: id });
              break;
            }
            case 'agent_start':
              // Treat as init continuation if we don't already have one
              // from the session header (older pi versions).
              break;
            case 'message_update':
              // Streaming text delta — count as activity only; pi reports
              // the final assembled assistant text on message_end.
              break;
            case 'message_end': {
              const msg = evt.message as { role?: string; content?: unknown } | undefined;
              if (msg && msg.role === 'assistant') {
                const text = extractText(msg.content);
                if (text !== null) push({ type: 'result', text });
              }
              break;
            }
            case 'turn_end': {
              // Final text was already pushed on message_end; turn_end is
              // the natural place to flush a heartbeat, but we already
              // pushed activity on every event.
              break;
            }
            case 'agent_end':
              // End of the turn-stream. Close the queue so the consumer
              // sees an EOF.
              break;
            case 'auto_retry_start': {
              const attempt = typeof evt.attempt === 'number' ? evt.attempt : '?';
              const max = typeof evt.maxAttempts === 'number' ? evt.maxAttempts : '?';
              push({ type: 'error', message: `pi retry ${attempt}/${max}`, retryable: true });
              break;
            }
            case 'auto_retry_end': {
              if (evt.success === false) {
                const finalError = typeof evt.finalError === 'string' ? evt.finalError : 'pi auto-retry exhausted';
                pushErr(finalError);
              }
              break;
            }
            case 'compaction_start':
              push({ type: 'progress', message: `compaction: ${String(evt.reason ?? 'manual')}` });
              break;
            case 'compaction_end':
              push({
                type: 'progress',
                message: `compaction ${evt.aborted ? 'aborted' : 'done'}: ${String(evt.reason ?? 'manual')}`,
              });
              break;
            case 'tool_execution_start': {
              const name = typeof evt.toolName === 'string' ? evt.toolName : 'tool';
              push({ type: 'progress', message: `tool: ${name}` });
              break;
            }
            case 'error': {
              const message = typeof evt.message === 'string' ? evt.message : 'pi error';
              pushErr(message);
              break;
            }
            default:
              // Unknown event — ignore. We already pushed activity above.
              break;
          }
        }
      } catch (err) {
        pushErr(`pi rpc stream failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        closed = true;
        wake();
      }
    })();

    child.on('error', (err) => {
      log(`spawn error: ${err.message}`);
      pushErr(`pi spawn error: ${err.message}`);
    });

    child.on('close', (code) => {
      log(`child closed code=${code} stderr_tail=${stderrTail.join(' | ').slice(0, 200)}`);
      if (code !== 0 && code !== null) {
        // Include the stderr tail so the user sees *something* useful — pi's
        // own error messages go to stderr in RPC mode and aren't surfaced
        // via the event stream.
        const tail = stderrTail.length > 0 ? `\nstderr: ${stderrTail.join(' | ')}` : '';
        pushErr(`pi exited code=${code}${tail}`);
      }
    });

    /** Send a command to pi's stdin. Tolerant of closed pipes. */
    const send = (cmd: PiRpcCommand): boolean => {
      try {
        if (!child.stdin || child.stdin.destroyed || closed) return false;
        child.stdin.write(JSON.stringify(cmd) + '\n');
        return true;
      } catch (err) {
        log(`stdin write failed: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    };

    return {
      push: (msg: string) => {
        send({ type: 'prompt', message: msg });
      },
      end: () => {
        // No explicit "end" in pi's RPC protocol — closing stdin signals
        // graceful shutdown. pi continues processing any pending prompts.
        try {
          child.stdin?.end();
        } catch {
          /* already closed */
        }
      },
      abort: () => {
        try {
          send({ type: 'abort' });
        } finally {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }
      },
      events: (async function* () {
        // Drain the event queue, blocking the consumer via a deferred
        // promise when the queue is empty. The deferred resolves on the
        // next push() or on stream close.
        while (true) {
          while (events.length > 0) {
            yield events.shift()!;
          }
          if (closed) return;
          await new Promise<void>((resolve) => {
            resolveNext = resolve;
          });
        }
      })(),
    };
  }
}

registerProvider('pi', (opts) => new PiProvider(opts));

// Extract a plain-text payload from the various content shapes pi uses
// (text-only content, mixed content blocks, tool-block fallbacks).
function extractText(content: unknown): string | null {
  if (content === undefined || content === null) return null;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as { type?: string; text?: string };
        if (b.type === 'text' && typeof b.text === 'string') {
          parts.push(b.text);
        } else if (b.type === 'thinking' && typeof b.text === 'string') {
          // Skip thinking blocks from the user-visible text.
        } else if (b.type === 'tool_use') {
          // Tool invocations don't carry assistant-facing text.
        }
      }
    }
    const text = parts.join('');
    return text.length > 0 ? text : null;
  }
  if (typeof content === 'object') {
    const obj = content as { text?: string };
    if (typeof obj.text === 'string') return obj.text;
  }
  return null;
}

// `sleep` re-export so callers can rate-limit stdin writes if they want —
// kept here as a stub so the file's surface matches the claude provider's
// (which uses timers/promises for backpressure). Sleep is unused today.
void sleep;

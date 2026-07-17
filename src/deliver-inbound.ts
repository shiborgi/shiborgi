/**
 * Wake-pipeline delivery: session-resolve + write-session-message +
 * typing-refresh + container-wake, all in one seam.
 *
 * Extracted from src/router.ts so the fanout loop becomes a thin
 * orchestrator that hands each engaging agent to this function. The
 * pass-through from router is:
 *
 *   resolveSession         (this module)
 *   writeSessionMessage    (this module)
 *   writeOutboundDirect    (this module, for command-deny feedback)
 *   startTypingRefresh     (this module, engages branch only)
 *   wakeContainer          (this module, injected to avoid a cycle — see
 *                           imports below)
 *
 * The router layer keeps the fanout policy (engagement + access + scope
 * gates) and the auto-create + dropped-message bookkeeping. This module
 * only owns what happens after a (wiring × message) pair has decided to
 * engage.
 *
 * Cyclic-dependency note: this file calls `wakeContainer` from
 * container-runner. container-runner already calls session-manager
 * helpers (sessionDir, writeSessionRouting, markContainer*). The
 * dependency arrow is:
 *
 *   router → deliver-inbound → session-manager
 *                  ↓
 *                  container-runner  (wake fn only)
 *
 * `container-runner.ts` does NOT import deliver-inbound — the direction
 * stays one-way. wakeContainer is imported via dynamic import to keep
 * TS happy if a future refactor makes the cycle tighter.
 */
import { gateCommand } from './command-gate.js';
import { resolveSession, writeSessionMessage, writeOutboundDirect } from './session-manager.js';
import { startTypingRefresh, stopTypingRefresh } from './modules/typing/index.js';
import { getSession } from './db/sessions.js';
import { log } from './log.js';
import type { InboundEvent } from './channels/adapter.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent } from './types.js';

/**
 * The container-runner wake function, taken as an injected dependency so
 * this module has no compile-time cycle with container-runner.
 *
 * Production callers use `container-runner.wakeContainer`. Tests inject a
 * stub that records calls and returns false (to exercise the
 * stopTypingRefresh rollback path).
 */
export type WakeFn = (session: import('./types.js').Session) => Promise<boolean>;

const defaultWake: WakeFn = async (session) => {
  // Dynamic import breaks any future cycle: container-runner imports
  // session-manager helpers (sessionDir, writeSessionRouting,
  // markContainer*), so we keep this side as a one-way edge.
  const { wakeContainer } = await import('./container-runner.js');
  return wakeContainer(session);
};

let wakeFn: WakeFn = defaultWake;

/** Test seam — replace the wake function without reloading modules. */
export function setWakeFn(fn: WakeFn): void {
  wakeFn = fn;
}

export interface DeliverInboundInput {
  agent: MessagingGroupAgent;
  agentGroup: AgentGroup;
  mg: MessagingGroup;
  event: InboundEvent;
  /** Resolved by the sender resolver; may be null when the module is absent. */
  userId: string | null;
  /** True when the thread-policy resolution kept threads on for this wiring. */
  threadsEnabled: boolean;
  /** Effective thread id after thread-policy resolution. */
  effectiveThreadId: string | null;
  /** True for the engaged branch; false for accumulated-but-silent storage. */
  wake: boolean;
}

/**
 * Write the inbound message into the agent's session DB and (when `wake`
 * is true) start the typing indicator + wake the container. The router's
 * fanout loop calls this once per (agent, message) pair that engaged.
 *
 * Side effects, in order:
 *   1. Apply the resolved session-mode (per-thread if threadsEnabled and
 *      not agent-shared and a group chat).
 *   2. resolveSession — find or create the per-(agent, mg, thread) row.
 *   3. Command gate — slash commands are filtered (silent drop) or denied
 *      (in-band message). Both early-return from this function.
 *   4. writeSessionMessage — the inbound row that the container will read
 *      on its next poll.
 *   5. startTypingRefresh + wakeContainer (engaged branch only).
 *
 * The `wake` path also stops the typing indicator if wakeContainer returns
 * false (transient spawn failure; host-sweep will retry, and the inbound
 * row stays pending so the agent eventually picks it up).
 */
export async function deliverInbound(input: DeliverInboundInput): Promise<void> {
  const { agent, agentGroup, mg, event, userId, threadsEnabled, effectiveThreadId, wake } = input;

  // Apply the resolved thread policy (wiring override AND channel declaration
  // AND adapter capability — resolveThreadPolicy at fanout): thread-enabled
  // wiring in a group chat → per-thread session regardless of wiring
  // session_mode. agent-shared preserved (it's a cross-channel directive the
  // adapter doesn't know about). DMs collapse sub-threads to one session
  // (is_group=0 short-circuit).
  let effectiveSessionMode = agent.session_mode;
  if (threadsEnabled && effectiveSessionMode !== 'agent-shared' && mg.is_group !== 0) {
    effectiveSessionMode = 'per-thread';
  }

  const { session, created } = resolveSession(agent.agent_group_id, mg.id, effectiveThreadId, effectiveSessionMode);

  // The inbound row's (channel_type, platform_id, thread_id) is the address
  // the agent's reply will be delivered to. Normally it mirrors the source
  // (stamped from the event, with the wiring's thread policy applied). When
  // the caller supplied `replyTo` (CLI admin transport acting on operator
  // intent), the reply is redirected there — replyTo is exempt from
  // thread-policy stripping.
  const deliveryAddr = event.replyTo ?? {
    channelType: event.channelType,
    platformId: event.platformId,
    threadId: effectiveThreadId,
  };

  // Command gate: classify slash commands before they reach the container.
  // Filtered commands are dropped silently. Denied admin commands get a
  // permission-denied response written directly to messages_out.
  if (event.message.kind === 'chat' || event.message.kind === 'chat-sdk') {
    const gate = gateCommand(event.message.content, userId, agent.agent_group_id);
    if (gate.action === 'filter') {
      log.debug('Filtered command dropped by gate', { agentGroupId: agent.agent_group_id });
      return;
    }
    if (gate.action === 'deny') {
      writeOutboundDirect(session.agent_group_id, session.id, {
        id: `deny-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        platformId: deliveryAddr.platformId,
        channelType: deliveryAddr.channelType,
        threadId: deliveryAddr.threadId,
        content: JSON.stringify({ text: `Permission denied: ${gate.command} requires admin access.` }),
      });
      log.info('Admin command denied by gate', { command: gate.command, userId, agentGroupId: agent.agent_group_id });
      return;
    }
  }

  writeSessionMessage(session.agent_group_id, session.id, {
    id: messageIdForAgent(event.message.id, agent.agent_group_id),
    kind: event.message.kind,
    timestamp: event.message.timestamp,
    platformId: deliveryAddr.platformId,
    channelType: deliveryAddr.channelType,
    threadId: deliveryAddr.threadId,
    content: event.message.content,
    trigger: wake ? 1 : 0,
  });

  log.info('Message routed', {
    sessionId: session.id,
    agentGroup: agent.agent_group_id,
    engage_mode: agent.engage_mode,
    kind: event.message.kind,
    userId,
    wake,
    created,
    agentGroupName: agentGroup.name,
  });

  if (wake) {
    // Typing indicator + wake are only for the engaged branch; accumulated
    // messages sit silently until a real trigger fires.
    // Typing fires via the adapter instance that owns this chat's row.
    startTypingRefresh(
      session.id,
      session.agent_group_id,
      event.channelType,
      event.platformId,
      effectiveThreadId,
      mg.instance,
    );
    const freshSession = getSession(session.id);
    if (freshSession) {
      const woke = await wakeFn(freshSession);
      // wake never throws — it returns false on transient spawn failure
      // (host-sweep retries). Stop the typing indicator we just started so
      // it doesn't leak; the inbound row stays pending.
      if (!woke) stopTypingRefresh(freshSession.id);
    }
  }
}

/**
 * When fanning out, the same inbound message lands in multiple per-agent
 * session DBs. messages_in.id is PRIMARY KEY, so reuse of the raw id would
 * collide across sessions (or, more subtly, within one session if re-routed
 * after a retry). Namespace by agent_group_id to keep ids unique per session.
 */
function messageIdForAgent(baseId: string | undefined, agentGroupId: string): string {
  const id = baseId && baseId.length > 0 ? baseId : `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${id}:${agentGroupId}`;
}

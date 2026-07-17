/**
 * Pure evaluator: does a wired agent engage on this inbound message?
 *
 * Extracted from src/router.ts so the engagement decision can be unit-tested
 * in isolation (no DB, no channel adapter). Callers retain the final dispatch
 * via the session-manager — see src/router.ts and `routeInbound`.
 *
 * Engagement modes:
 *   - 'pattern'        — regex test on text; '.' = always
 *   - 'mention'        — bot must be mentioned on the platform. The mention
 *                        signal comes from the adapter (`event.message.isMention`)
 *                        and reflects platform-native @-mentions of the bot.
 *                        `agent_group.name` is irrelevant here — a user can't
 *                        use a NanoClaw-side display name as a mention.
 *   - 'mention-sticky' — platform mention OR an active per-thread session
 *                        already exists for this (agent, mg, thread). The
 *                        session existence IS our subscription state; once a
 *                        thread has engaged us once, follow-ups arrive with no
 *                        mention and should still fire.
 *
 * This function is `pure` in the sense that it does not mutate state or
 * perform IO. The mention-sticky variant does call `findSessionForAgent`,
 * which is a single synchronous DB read — treat it as a simple lookup, not
 * orchestration. If the host's design tightens to forbid even that, extract
 * the session-existence check into a passed-in predicate.
 */
import { findSessionForAgent } from '../db/sessions.js';
import type { MessagingGroup, MessagingGroupAgent } from '../types.js';

export interface EngagementInput {
  /** The wiring (one row of `messaging_group_agents`). */
  agent: MessagingGroupAgent;
  /** Decoded message text (parsed from `event.message.content`). */
  text: string;
  /** True when the inbound message addressed the bot (adapter-resolved). */
  isMention: boolean;
  /** The messaging group (for is_group + sticky-session lookup). */
  mg: MessagingGroup;
  /** Effective thread id after thread-policy resolution (NULL for DMs). */
  threadId: string | null;
}

/**
 * Decide whether a given wired agent should engage on this message.
 *
 * Returns true when the engagement policy (engage_mode/engage_pattern) fires.
 * The router then layers access-gate and sender-scope-gate checks on top —
 * those are outside this module's concern.
 */
export function evaluateWiringEngagement(input: EngagementInput): boolean {
  const { agent, text, isMention, mg, threadId } = input;
  switch (agent.engage_mode) {
    case 'pattern': {
      const pat = agent.engage_pattern ?? '.';
      if (pat === '.') return true;
      try {
        return new RegExp(pat).test(text);
      } catch {
        // Bad regex: fail open so admin sees the agent responding + can fix.
        return true;
      }
    }
    case 'mention':
      return isMention;
    case 'mention-sticky': {
      if (isMention) return true;
      // Sticky follow-up: session already exists for this (agent, mg, thread)
      // — the thread was activated before, keep firing.
      if (mg.is_group === 0) return false; // DMs never use mention-sticky sensibly
      const existing = findSessionForAgent(agent.agent_group_id, mg.id, threadId);
      return existing !== undefined;
    }
    default:
      return false;
  }
}

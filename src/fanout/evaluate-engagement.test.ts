import { describe, it, expect, vi } from 'vitest';

// Mock the single DB-read dependency so this is a true pure function test.
vi.mock('../db/sessions.js', () => ({
  findSessionForAgent: vi.fn(),
}));
import { findSessionForAgent } from '../db/sessions.js';
import { evaluateWiringEngagement } from './evaluate-engagement.js';
import type { MessagingGroup, MessagingGroupAgent } from '../types.js';

function mkAgent(overrides: Partial<MessagingGroupAgent> = {}): MessagingGroupAgent {
  return {
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    session_mode: 'shared',
    engage_mode: 'mention',
    engage_pattern: null,
    priority: 0,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function mkMg(overrides: Partial<MessagingGroup> = {}): MessagingGroup {
  return {
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'chat-1',
    instance: 'telegram',
    name: 'Test group',
    is_group: 1,
    unknown_sender_policy: 'request_approval',
    denied_at: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('evaluateWiringEngagement', () => {
  describe('engage_mode=pattern', () => {
    it("matches '.' as 'respond to everything'", () => {
      const agent = mkAgent({ engage_mode: 'pattern', engage_pattern: '.' });
      expect(
        evaluateWiringEngagement({
          agent,
          text: 'totally unrelated message',
          isMention: false,
          mg: mkMg(),
          threadId: null,
        }),
      ).toBe(true);
    });

    it('matches a custom regex against the text', () => {
      const agent = mkAgent({ engage_mode: 'pattern', engage_pattern: '\\bhelp\\b' });
      expect(
        evaluateWiringEngagement({
          agent,
          text: 'I need help with my wifi',
          isMention: false,
          mg: mkMg(),
          threadId: null,
        }),
      ).toBe(true);
    });

    it('returns false when the text does not match', () => {
      const agent = mkAgent({ engage_mode: 'pattern', engage_pattern: '^/admin' });
      expect(
        evaluateWiringEngagement({
          agent,
          text: 'ordinary chatter',
          isMention: false,
          mg: mkMg(),
          threadId: null,
        }),
      ).toBe(false);
    });

    it('falls open on a bad regex (admin-facing debug)', () => {
      const agent = mkAgent({ engage_mode: 'pattern', engage_pattern: '[unclosed' });
      expect(
        evaluateWiringEngagement({
          agent,
          text: 'anything',
          isMention: false,
          mg: mkMg(),
          threadId: null,
        }),
      ).toBe(true);
    });
  });

  describe('engage_mode=mention', () => {
    it('engages only when isMention=true', () => {
      const agent = mkAgent({ engage_mode: 'mention' });
      expect(
        evaluateWiringEngagement({
          agent,
          text: 'hello bot',
          isMention: true,
          mg: mkMg(),
          threadId: 't1',
        }),
      ).toBe(true);
    });

    it('does not engage on plain chatter', () => {
      const agent = mkAgent({ engage_mode: 'mention' });
      expect(
        evaluateWiringEngagement({
          agent,
          text: 'hello',
          isMention: false,
          mg: mkMg(),
          threadId: 't1',
        }),
      ).toBe(false);
    });
  });

  describe('engage_mode=mention-sticky', () => {
    it('engages on mention regardless of session', () => {
      const agent = mkAgent({ engage_mode: 'mention-sticky' });
      vi.mocked(findSessionForAgent).mockReturnValue(undefined);
      expect(
        evaluateWiringEngagement({
          agent,
          text: 'hi',
          isMention: true,
          mg: mkMg({ is_group: 1 }),
          threadId: 't1',
        }),
      ).toBe(true);
    });

    it('engages on subsequent messages when session exists', () => {
      const agent = mkAgent({ engage_mode: 'mention-sticky' });
      vi.mocked(findSessionForAgent).mockReturnValue({
        id: 's-1',
        agent_group_id: 'ag-1',
        messaging_group_id: 'mg-1',
        thread_id: 't1',
        session_mode: 'per-thread',
        container_state: 'idle',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        last_message_at: null,
        last_message_seq: null,
        last_processing_ack: null,
      } as never);
      expect(
        evaluateWiringEngagement({
          agent,
          text: 'follow-up reply, no @',
          isMention: false,
          mg: mkMg({ is_group: 1 }),
          threadId: 't1',
        }),
      ).toBe(true);
    });

    it('refuses follow-ups when no session exists yet', () => {
      const agent = mkAgent({ engage_mode: 'mention-sticky' });
      vi.mocked(findSessionForAgent).mockReturnValue(undefined);
      expect(
        evaluateWiringEngagement({
          agent,
          text: 'noise',
          isMention: false,
          mg: mkMg({ is_group: 1 }),
          threadId: 't1',
        }),
      ).toBe(false);
    });

    it('refuses follow-ups in DMs (mention-sticky is group-only)', () => {
      const agent = mkAgent({ engage_mode: 'mention-sticky' });
      vi.mocked(findSessionForAgent).mockReturnValue(undefined);
      expect(
        evaluateWiringEngagement({
          agent,
          text: 'hi',
          isMention: false,
          mg: mkMg({ is_group: 0 }),
          threadId: null,
        }),
      ).toBe(false);
    });
  });

  describe('unknown engage_mode', () => {
    it('defaults to no engagement', () => {
      const agent = mkAgent({ engage_mode: 'something-else' as never });
      expect(
        evaluateWiringEngagement({
          agent,
          text: 'hi',
          isMention: true,
          mg: mkMg(),
          threadId: null,
        }),
      ).toBe(false);
    });
  });
});

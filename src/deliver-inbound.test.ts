import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock session-manager — exercises deliverInbound against a fake implementation.
const mockWriteSessionMessage = vi.fn();
const mockWriteOutboundDirect = vi.fn();
const mockResolveSession = vi.fn();
vi.mock('./session-manager.js', () => ({
  resolveSession: (...args: unknown[]) => mockResolveSession(...args),
  writeSessionMessage: (...args: unknown[]) => mockWriteSessionMessage(...args),
  writeOutboundDirect: (...args: unknown[]) => mockWriteOutboundDirect(...args),
}));

// Mock typing refresh — we don't need real indicator behavior in unit tests.
const mockStartTyping = vi.fn();
const mockStopTyping = vi.fn();
vi.mock('./modules/typing/index.js', () => ({
  startTypingRefresh: (...args: unknown[]) => mockStartTyping(...args),
  stopTypingRefresh: (...args: unknown[]) => mockStopTyping(...args),
}));

// Mock getSession — used after wake to fetch the fresh row.
const mockGetSession = vi.fn();
vi.mock('./db/sessions.js', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

// Mock gate — gateCommand returns the input-by-action matrix below.
const mockGate = vi.fn();
vi.mock('./command-gate.js', () => ({
  gateCommand: (...args: unknown[]) => mockGate(...args),
}));

// Wake seam — tests inject a stub.
import { deliverInbound, setWakeFn, type WakeFn } from './deliver-inbound.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent, Session } from './types.js';
import type { InboundEvent } from './channels/adapter.js';

function mkAgent(overrides: Partial<MessagingGroupAgent> = {}): MessagingGroupAgent {
  return {
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'mention',
    engage_pattern: null,
    priority: 0,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function mkEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    channelType: 'telegram',
    instance: 'telegram',
    platformId: 'chat-1',
    threadId: null,
    message: {
      id: 'msg-1',
      kind: 'chat',
      content: JSON.stringify({ text: 'hello' }),
      timestamp: '2026-01-01T00:00:00Z',
      isMention: false,
      isGroup: false,
    },
    ...overrides,
  };
}

function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    last_message_at: null,
    last_message_seq: null,
    last_processing_ack: null,
    ...overrides,
  } as Session;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveSession.mockReturnValue({ session: mkSession(), created: false });
  mockGetSession.mockReturnValue(mkSession());
  mockGate.mockReturnValue({ action: 'pass' });
});

describe('deliverInbound', () => {
  describe('wake=true path', () => {
    it('resolves session and writes the message with trigger=1', async () => {
      const wake: WakeFn = vi.fn().mockResolvedValue(true);
      setWakeFn(wake);

      await deliverInbound({
        agent: mkAgent(),
        agentGroup: { id: 'ag-1', folder: 'ag1', name: 'Agent One', created_at: '' } as AgentGroup,
        mg: { id: 'mg-1', channel_type: 'telegram', platform_id: 'chat-1', instance: 'telegram', name: null, is_group: 0, unknown_sender_policy: 'request_approval', denied_at: null, created_at: '' } as MessagingGroup,
        event: mkEvent(),
        userId: 'u-1',
        threadsEnabled: false,
        effectiveThreadId: null,
        wake: true,
      });

      expect(mockResolveSession).toHaveBeenCalled();
      expect(mockWriteSessionMessage).toHaveBeenCalledOnce();
      const written = mockWriteSessionMessage.mock.calls[0];
      expect(written[2].trigger).toBe(1);
      expect(written[2].content).toBe(JSON.stringify({ text: 'hello' }));
      // namespaced id
      expect(written[2].id).toBe('msg-1:ag-1');

      expect(mockStartTyping).toHaveBeenCalledOnce();
      expect(wake).toHaveBeenCalledOnce();
      // wake returned true → stopTyping must not run
      expect(mockStopTyping).not.toHaveBeenCalled();
    });

    it('stops the typing indicator when wake returns false', async () => {
      const wake: WakeFn = vi.fn().mockResolvedValue(false);
      setWakeFn(wake);

      await deliverInbound({
        agent: mkAgent(),
        agentGroup: { id: 'ag-1' } as AgentGroup,
        mg: { id: 'mg-1', is_group: 0 } as MessagingGroup,
        event: mkEvent(),
        userId: null,
        threadsEnabled: false,
        effectiveThreadId: null,
        wake: true,
      });

      expect(mockStartTyping).toHaveBeenCalledOnce();
      expect(wake).toHaveBeenCalledOnce();
      expect(mockStopTyping).toHaveBeenCalledOnce();
    });

    it('preserves the event replyTo as the delivery address', async () => {
      setWakeFn(vi.fn().mockResolvedValue(true));

      const replyToEvent = mkEvent({
        replyTo: {
          channelType: 'cli',
          platformId: 'admin-1',
          threadId: 'admin-thread-1',
        },
      });

      await deliverInbound({
        agent: mkAgent(),
        agentGroup: {} as AgentGroup,
        mg: { id: 'mg-1', is_group: 0 } as MessagingGroup,
        event: replyToEvent,
        userId: null,
        threadsEnabled: false,
        effectiveThreadId: 't-1',
        wake: true,
      });

      const written = mockWriteSessionMessage.mock.calls[0];
      expect(written[2].platformId).toBe('admin-1'); // replyTo.platformId wins
      expect(written[2].channelType).toBe('cli'); // replyTo.channelType wins
      expect(written[2].threadId).toBe('admin-thread-1'); // replyTo.threadId wins, NOT effectiveThreadId
    });
  });

  describe('wake=false (accumulate) path', () => {
    it('writes the message with trigger=0 and does NOT start typing or wake', async () => {
      const wake: WakeFn = vi.fn();
      setWakeFn(wake);

      await deliverInbound({
        agent: mkAgent(),
        agentGroup: {} as AgentGroup,
        mg: { id: 'mg-1', is_group: 0 } as MessagingGroup,
        event: mkEvent(),
        userId: null,
        threadsEnabled: false,
        effectiveThreadId: null,
        wake: false,
      });

      const written = mockWriteSessionMessage.mock.calls[0];
      expect(written[2].trigger).toBe(0);
      expect(mockStartTyping).not.toHaveBeenCalled();
      expect(wake).not.toHaveBeenCalled();
      expect(mockStopTyping).not.toHaveBeenCalled();
    });
  });

  describe('thread policy resolution', () => {
    it('upgrades session_mode to per-thread when threadsEnabled + not agent-shared + group', async () => {
      setWakeFn(vi.fn().mockResolvedValue(true));

      await deliverInbound({
        agent: mkAgent({ session_mode: 'shared' }),
        agentGroup: {} as AgentGroup,
        mg: { id: 'mg-1', is_group: 1 } as MessagingGroup,
        event: mkEvent(),
        userId: null,
        threadsEnabled: true,
        effectiveThreadId: 't-99',
        wake: true,
      });

      expect(mockResolveSession).toHaveBeenCalledWith('ag-1', 'mg-1', 't-99', 'per-thread');
    });

    it('preserves agent-shared even when threadsEnabled', async () => {
      setWakeFn(vi.fn().mockResolvedValue(true));

      await deliverInbound({
        agent: mkAgent({ session_mode: 'agent-shared' }),
        agentGroup: {} as AgentGroup,
        mg: { id: 'mg-1', is_group: 1 } as MessagingGroup,
        event: mkEvent(),
        userId: null,
        threadsEnabled: true,
        effectiveThreadId: 't-1',
        wake: true,
      });

      expect(mockResolveSession).toHaveBeenCalledWith('ag-1', 'mg-1', 't-1', 'agent-shared');
    });

    it('keeps session_mode unchanged when threadsEnabled is false', async () => {
      setWakeFn(vi.fn().mockResolvedValue(true));

      await deliverInbound({
        agent: mkAgent({ session_mode: 'shared' }),
        agentGroup: {} as AgentGroup,
        mg: { id: 'mg-1', is_group: 1 } as MessagingGroup,
        event: mkEvent(),
        userId: null,
        threadsEnabled: false,
        effectiveThreadId: null,
        wake: true,
      });

      expect(mockResolveSession).toHaveBeenCalledWith('ag-1', 'mg-1', null, 'shared');
    });
  });

  describe('command gate', () => {
    it('drops silently when the gate filters the command', async () => {
      mockGate.mockReturnValue({ action: 'filter', command: '/secret' });
      const wake: WakeFn = vi.fn();
      setWakeFn(wake);

      await deliverInbound({
        agent: mkAgent(),
        agentGroup: {} as AgentGroup,
        mg: { id: 'mg-1', is_group: 0 } as MessagingGroup,
        event: mkEvent({ message: { ...mkEvent().message, content: '/secret token=123' } }),
        userId: 'u-1',
        threadsEnabled: false,
        effectiveThreadId: null,
        wake: true,
      });

      expect(mockWriteSessionMessage).not.toHaveBeenCalled();
      expect(wake).not.toHaveBeenCalled();
      expect(mockWriteOutboundDirect).not.toHaveBeenCalled();
    });

    it('writes a permission-denied message and returns when the gate denies', async () => {
      mockGate.mockReturnValue({ action: 'deny', command: '/kill' });
      const wake: WakeFn = vi.fn();
      setWakeFn(wake);

      await deliverInbound({
        agent: mkAgent(),
        agentGroup: {} as AgentGroup,
        mg: { id: 'mg-1', is_group: 0 } as MessagingGroup,
        event: mkEvent(),
        userId: 'u-1',
        threadsEnabled: false,
        effectiveThreadId: null,
        wake: true,
      });

      expect(mockWriteOutboundDirect).toHaveBeenCalledOnce();
      const written = mockWriteOutboundDirect.mock.calls[0];
      expect(written[0]).toBe('ag-1'); // agent_group_id
      expect(written[1]).toBe('sess-1'); // session id
      const outboundMessage = written[2];
      const parsed = JSON.parse(outboundMessage.content);
      expect(parsed.text).toContain('Permission denied');
      expect(parsed.text).toContain('/kill');
      expect(mockWriteSessionMessage).not.toHaveBeenCalled();
      expect(wake).not.toHaveBeenCalled();
    });
  });

  describe('id namespacing', () => {
    it('namespaces the inbound id with the agent_group_id', async () => {
      setWakeFn(vi.fn().mockResolvedValue(true));

      await deliverInbound({
        agent: mkAgent(),
        agentGroup: {} as AgentGroup,
        mg: { id: 'mg-1', is_group: 0 } as MessagingGroup,
        event: mkEvent(),
        userId: null,
        threadsEnabled: false,
        effectiveThreadId: null,
        wake: true,
      });

      const written = mockWriteSessionMessage.mock.calls[0];
      expect(written[2].id).toBe('msg-1:ag-1');
    });
  });
});

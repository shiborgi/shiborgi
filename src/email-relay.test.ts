import { describe, expect, it } from 'vitest';
import { formatRelayMessage, validSignature } from './email-relay.js';
import crypto from 'node:crypto';

describe('email relay', () => {
  it('formats bounded WhatsApp content', () => {
    const text = formatRelayMessage({ from: 'a@example.com', subject: 'Alert', body: 'hello' });
    expect(text).toContain('De: a@example.com');
    expect(text).toContain('Assunto: Alert');
    expect(formatRelayMessage({ from: 'a', subject: 'b', body: 'x'.repeat(100) }, 20)).toHaveLength(20);
  });
  it('accepts only the exact HMAC signature', () => {
    const body = Buffer.from('{"messageId":"m1"}');
    const signature = crypto.createHmac('sha256', 'secret').update(body).digest('base64');
    expect(validSignature(body, signature, 'secret')).toBe(true);
    expect(validSignature(body, signature, 'other')).toBe(false);
    expect(validSignature(body, undefined, 'secret')).toBe(false);
  });
});

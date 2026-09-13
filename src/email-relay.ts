import crypto from 'node:crypto';
import type http from 'node:http';
import { getMessagingGroupByPlatform } from './db/messaging-groups.js';
import type { DbDriver } from './db/driver.js';
import { registerWebhookHandler } from './webhook-server.js';
import { getChannelAdapterExact } from './channels/channel-registry.js';
import { onHostStart } from './host-lifecycle.js';

const MAX_EVENT_BYTES = 256 * 1024;
type RelayEvent = {
  relayId: string;
  messageId: string;
  issuedAt: string;
  from: string;
  subject: string;
  body: string;
  destination: { channelType: 'whatsapp'; instance?: string; platformId: string };
};

function read(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_EVENT_BYTES) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function validSignature(body: Buffer, supplied: string | undefined, secret: string): boolean {
  if (!supplied || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64');
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function formatRelayMessage(event: Pick<RelayEvent, 'from' | 'subject' | 'body'>, max = 12000): string {
  return `Email recebido\nDe: ${event.from}\nAssunto: ${event.subject}\n\n${event.body}`.slice(0, max);
}

export function registerEmailRelay(db: DbDriver): void {
  registerWebhookHandler('email-relay', async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    try {
      const raw = await read(req);
      const event = JSON.parse(raw.toString('utf8')) as RelayEvent;
      if (
        !event.relayId ||
        !event.messageId ||
        !event.issuedAt ||
        !event.destination?.platformId ||
        event.destination.channelType !== 'whatsapp'
      )
        throw new Error('invalid relay event');
      if (!Number.isFinite(Date.parse(event.issuedAt)) || Math.abs(Date.now() - Date.parse(event.issuedAt)) > 300_000)
        throw new Error('stale relay event');
      const secret = process.env.EMAIL_RELAY_SECRET ?? '';
      if (!validSignature(raw, req.headers['x-email-relay-signature'] as string | undefined, secret)) {
        res.writeHead(401);
        res.end('unauthorized');
        return;
      }
      const inserted = await db.run(
        'INSERT OR IGNORE INTO email_relay_events (message_id, relay_id, received_at) VALUES (?, ?, ?)',
        event.messageId,
        event.relayId,
        new Date().toISOString(),
      );
      if (!inserted.changes) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true,"duplicate":true}');
        return;
      }
      const mg = await getMessagingGroupByPlatform(
        'whatsapp',
        event.destination.platformId,
        event.destination.instance,
      );
      if (!mg) throw new Error('WhatsApp destination is not registered');
      const adapter = getChannelAdapterExact(mg.instance ?? 'whatsapp');
      if (!adapter) throw new Error('WhatsApp adapter is offline');
      const text = formatRelayMessage(event);
      await adapter.deliver(mg.platform_id, null, { kind: 'chat', content: { text } });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    } catch (error) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end(error instanceof Error ? error.message : 'invalid relay event');
    }
  });
}

onHostStart(async ({ db }) => {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS email_relay_events (message_id TEXT PRIMARY KEY, relay_id TEXT NOT NULL, received_at TEXT NOT NULL)',
  );
  registerEmailRelay(db);
});

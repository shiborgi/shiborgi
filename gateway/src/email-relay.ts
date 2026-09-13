import { googleAccessToken } from './google-oauth.js';
import type { EmailRelay, LoadedConfig } from './config.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users';

function header(headers: unknown, name: string): string {
  if (!Array.isArray(headers)) return '';
  const row = headers.find((h) => h && typeof h === 'object' && String((h as Record<string, unknown>).name).toLowerCase() === name.toLowerCase());
  return row && typeof (row as Record<string, unknown>).value === 'string' ? (row as Record<string, unknown>).value as string : '';
}

function decode(data: unknown): string {
  if (typeof data !== 'string') return '';
  return new TextDecoder().decode(Uint8Array.from(atob(data.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
}

function body(payload: any): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return decode(payload.body.data);
  for (const part of payload.parts ?? []) { const found = body(part); if (found) return found; }
  if (payload.mimeType === 'text/html' && payload.body?.data) return decode(payload.body.data).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return '';
}

function passes(relay: EmailRelay, from: string, subject: string, labels: string[]): boolean {
  const f = relay.filters;
  if (f.from?.length && !f.from.includes(from)) return false;
  if (f.domains?.length && !f.domains.some((d) => from.toLowerCase().endsWith(`@${d.toLowerCase()}`))) return false;
  if (f.subjectRegex?.length && !f.subjectRegex.some((r) => { try { return new RegExp(r).test(subject); } catch { return false; } })) return false;
  if (f.labels?.length && !f.labels.every((label) => labels.includes(label))) return false;
  return true;
}

async function gmail(token: string, path: string, query: Record<string, string> = {}): Promise<any> {
  const url = new URL(`${GMAIL}/${path}`); for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Gmail API returned ${response.status}`);
  return response.json();
}

export async function handleEmailRelay(request: Request, loaded: LoadedConfig, relayId: string): Promise<Response> {
  const relay = loaded.config.emailRelays[relayId];
  if (!relay) return new Response('unknown relay', { status: 404 });
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
  if (!request.headers.get('authorization')?.startsWith('Bearer ')) return new Response('unauthorized', { status: 401 });
  if (!loaded.secrets[relay.deliverySecret]) return new Response('relay secret is not configured', { status: 500 });
  const envelope = await request.json().catch(() => null) as any;
  const data = envelope?.message?.data;
  if (typeof data !== 'string') return new Response('invalid pubsub envelope', { status: 400 });
  const notification = JSON.parse(decode(data)) as { emailAddress?: string; historyId?: string };
  if (!notification.historyId) return new Response('missing historyId', { status: 400 });
  const profile = loaded.config.oauthProfiles[relay.oauthProfile]!;
  const token = await googleAccessToken(relay.oauthProfile, profile, loaded.secrets);
  const history = await gmail(token, `${relay.mailbox}/history`, { startHistoryId: notification.historyId, historyTypes: 'messageAdded' });
  let sent = 0;
  for (const record of history.history ?? []) {
    for (const added of record.messagesAdded ?? []) {
      if (sent >= relay.limits.maxMessagesPerEvent) break;
      const id = added.message?.id; if (!id) continue;
      const message = await gmail(token, `${relay.mailbox}/messages/${encodeURIComponent(id)}`, { format: 'full' });
      const from = header(message.payload?.headers, 'From'); const subject = header(message.payload?.headers, 'Subject');
      const text = body(message.payload).slice(0, relay.limits.maxBodyChars);
      if (!passes(relay, from, subject, message.labelIds ?? [])) continue;
      const event = { relayId, messageId: id, threadId: message.threadId ?? null, issuedAt: new Date().toISOString(), from, subject, body: text, labels: message.labelIds ?? [], destination: relay.destination };
      const payload = JSON.stringify(event);
      const signature = await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', new TextEncoder().encode(loaded.secrets[relay.deliverySecret] ?? ''), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), new TextEncoder().encode(payload));
      await fetch(relay.butlerEndpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-email-relay-signature': btoa(String.fromCharCode(...new Uint8Array(signature))) }, body: payload });
      sent += 1;
    }
  }
  return Response.json({ ok: true, sent });
}

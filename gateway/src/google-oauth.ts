/** Google refresh-token exchange. Access tokens are intentionally memory-only. */
import { GatewayConfigError, type GoogleOAuthProfile } from './config.js';

type CachedToken = { value: string; expiresAt: number };
const cache = new Map<string, CachedToken>();
const pending = new Map<string, Promise<string>>();

export async function googleAccessToken(profileName: string, profile: GoogleOAuthProfile, secrets: Record<string, string>): Promise<string> {
  const cached = cache.get(profileName);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
  const running = pending.get(profileName);
  if (running) return running;
  const request = refresh(profileName, profile, secrets).finally(() => pending.delete(profileName));
  pending.set(profileName, request);
  return request;
}

async function refresh(profileName: string, profile: GoogleOAuthProfile, secrets: Record<string, string>): Promise<string> {
  const clientId = secrets[profile.clientIdSecret];
  const clientSecret = secrets[profile.clientSecretSecret];
  const refreshToken = secrets[profile.refreshTokenSecret];
  if (!clientId || !clientSecret || !refreshToken) throw new GatewayConfigError(`Google OAuth profile "${profileName}" is not connected`);
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!response.ok) throw new GatewayConfigError(`Google OAuth profile "${profileName}" could not refresh its token`);
  const parsed = await response.json() as { access_token?: unknown; expires_in?: unknown };
  if (typeof parsed.access_token !== 'string') throw new GatewayConfigError(`Google OAuth profile "${profileName}" returned no access token`);
  const ttl = typeof parsed.expires_in === 'number' ? parsed.expires_in : 300;
  cache.set(profileName, { value: parsed.access_token, expiresAt: Date.now() + ttl * 1000 });
  return parsed.access_token;
}

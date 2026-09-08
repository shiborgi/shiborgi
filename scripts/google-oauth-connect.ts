/**
 * Connect a configured Google OAuth profile without ever printing its token.
 * Usage: pnpm exec tsx scripts/google-oauth-connect.ts <profile>
 *
 * Headless hosts are the normal deployment, and Google's loopback flow needs a
 * browser that can reach 127.0.0.1 on THIS host. So the callback port is
 * settable (`GOOGLE_OAUTH_PORT`) — a random one cannot be forwarded before the
 * script runs — and the URL is always printed before any attempt to open it.
 * Opening a browser is best-effort: on a machine with none, the printed URL and
 * an `ssh -L` tunnel are the whole procedure, and a failure to spawn a browser
 * must not kill the run before the operator has seen the link.
 */
import { createHash, randomBytes } from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { promisify } from 'util';

const profileName = process.argv[2];
if (!profileName) throw new Error('Usage: google-oauth-connect.ts <profile>');
const root = process.cwd();
const configPath = path.join(root, 'gateway/config/gateway.json');
const secretsPath = path.join(root, 'gateway/config/secrets.env');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { oauthProfiles?: Record<string, Record<string, unknown>> };
const profile = config.oauthProfiles?.[profileName];
if (!profile) throw new Error(`OAuth profile "${profileName}" is not configured in gateway.json`);
const required = ['expectedEmail', 'clientIdSecret', 'clientSecretSecret', 'refreshTokenSecret'] as const;
for (const key of required) if (typeof profile[key] !== 'string' || !profile[key]) throw new Error(`oauthProfiles.${profileName}.${key} is required`);
const values = Object.fromEntries(fs.readFileSync(secretsPath, 'utf8').split('\n').flatMap((line) => {
  const i = line.indexOf('='); return i > 0 ? [[line.slice(0, i).trim(), line.slice(i + 1).trim()]] : [];
}));
const clientId = values[profile.clientIdSecret as string];
const clientSecret = values[profile.clientSecretSecret as string];
if (!clientId || !clientSecret) throw new Error('Google OAuth client ID and secret must be set in gateway/config/secrets.env');
const state = randomBytes(32).toString('hex');
const verifier = randomBytes(48).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const server = http.createServer();
// 0 keeps the old behaviour (an ephemeral port) for a desktop run; a fixed one
// is what makes `ssh -L` possible, since the tunnel must exist before Google
// redirects to it.
const requestedPort = Number(process.env.GOOGLE_OAUTH_PORT ?? '0');
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
  throw new Error(`GOOGLE_OAUTH_PORT must be a port number (got ${String(process.env.GOOGLE_OAUTH_PORT)})`);
}
await new Promise<void>((resolve) => server.listen(requestedPort, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
const redirectUri = `http://127.0.0.1:${port}/oauth2/callback`;
const scopes = Array.isArray(profile.scopes) ? profile.scopes.filter((x): x is string => typeof x === 'string') : [];
const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', scope: scopes.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
console.log(`\nSign in as ${profile.expectedEmail} at:\n\n${authUrl.toString()}\n`);
console.log(`Google will redirect to ${redirectUri}, which is served by THIS host.`);
console.log(`From a machine with a browser, forward the port first:\n  ssh -L ${port}:127.0.0.1:${port} <this-host>\n`);
console.log('Waiting up to 5 minutes for the callback…');
try {
  await promisify(execFile)(process.platform === 'darwin' ? 'open' : 'xdg-open', [authUrl.toString()]);
} catch {
  // No browser on this host — the printed URL is the whole instruction, and
  // dying here would take it off the screen along with the run.
}
const code = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('OAuth timed out after 5 minutes')), 300_000);
  server.once('request', (req, res) => {
    const url = new URL(req.url ?? '/', redirectUri);
    if (url.searchParams.get('state') !== state || !url.searchParams.get('code')) { res.end('Authorization failed. You may close this tab.'); clearTimeout(timer); reject(new Error('Google OAuth state or code is invalid')); return; }
    res.end('Google account connected. You may close this tab.'); clearTimeout(timer); resolve(url.searchParams.get('code')!);
  });
});
server.close();
const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }) });
const token = await tokenResponse.json() as { access_token?: string; refresh_token?: string };
if (!tokenResponse.ok || !token.access_token || !token.refresh_token) throw new Error('Google did not issue an offline refresh token');
const info = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${token.access_token}` } }).then((r) => r.json()) as { email?: string; email_verified?: boolean };
if (info.email !== profile.expectedEmail || info.email_verified !== true) throw new Error(`Authenticated account does not match configured expectedEmail (${String(info.email)})`);
const key = profile.refreshTokenSecret as string;
const lines = fs.readFileSync(secretsPath, 'utf8').split('\n');
const index = lines.findIndex((line) => line.startsWith(`${key}=`));
if (index >= 0) lines[index] = `${key}=${token.refresh_token}`; else lines.push(`${key}=${token.refresh_token}`);
fs.writeFileSync(secretsPath, lines.join('\n'), { mode: 0o600 }); fs.chmodSync(secretsPath, 0o600);
console.log(`Connected ${info.email} to gateway OAuth profile "${profileName}".`);

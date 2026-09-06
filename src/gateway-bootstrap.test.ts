/**
 * What a fresh clone gets on first start.
 *
 * The behaviours worth pinning are the create-if-absent ones: an install that
 * has been running must keep the secret it has (rotating it invalidates every
 * live session's token), and an operator's edited policy must never be
 * overwritten by a scaffold that runs on every boot.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureGatewayConfigScaffold, ensureGatewaySecret } from './gateway-bootstrap.js';
import { GATEWAY_SECRET_ENV } from './gateway-identity.js';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-gw-bootstrap-'));
  const configDir = path.join(root, 'gateway', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'gateway.example.json'), '{"schemaVersion":1}\n');
  fs.writeFileSync(path.join(configDir, 'secrets.example.env'), '# fill me\nANTHROPIC_API_KEY=\n');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('install secret', () => {
  it('generates and persists one when the clone has none', () => {
    const secret = ensureGatewaySecret(root);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf-8')).toContain(`${GATEWAY_SECRET_ENV}=${secret}`);
  });

  it('keeps the existing secret, because rotating it invalidates live sessions', () => {
    const first = ensureGatewaySecret(root);
    expect(ensureGatewaySecret(root)).toBe(first);
    // And only one line was ever written.
    const lines = fs
      .readFileSync(path.join(root, '.env'), 'utf-8')
      .split('\n')
      .filter((l) => l.startsWith(GATEWAY_SECRET_ENV));
    expect(lines).toHaveLength(1);
  });

  it('appends without disturbing what an operator already put in .env', () => {
    fs.writeFileSync(path.join(root, '.env'), 'ASSISTANT_NAME=Bartender\nTZ=America/Sao_Paulo');
    ensureGatewaySecret(root);
    const env = fs.readFileSync(path.join(root, '.env'), 'utf-8');
    expect(env).toContain('ASSISTANT_NAME=Bartender');
    expect(env).toContain('TZ=America/Sao_Paulo');
    // The file had no trailing newline; the append must not join two settings.
    expect(env).not.toMatch(/TZ=America\/Sao_Paulo[^\n]*NANOCLAW_GATEWAY_SECRET/);
  });

  it('writes the file only the owner can read', () => {
    ensureGatewaySecret(root);
    const mode = fs.statSync(path.join(root, '.env')).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });
});

describe('config scaffold', () => {
  it('creates both files from their examples on a fresh clone', () => {
    const result = ensureGatewayConfigScaffold(root);
    expect(result.created.sort()).toEqual(['gateway/config/gateway.json', 'gateway/config/secrets.env']);
    expect(fs.existsSync(path.join(root, 'gateway', 'config', 'gateway.json'))).toBe(true);
  });

  it('never overwrites a policy an operator has edited', () => {
    const policy = path.join(root, 'gateway', 'config', 'gateway.json');
    ensureGatewayConfigScaffold(root);
    fs.writeFileSync(policy, '{"schemaVersion":1,"models":{"mine":{}}}');
    const second = ensureGatewayConfigScaffold(root);
    expect(second.created).toEqual([]);
    expect(fs.readFileSync(policy, 'utf-8')).toContain('mine');
  });

  it('keeps secrets readable only by the owner', () => {
    ensureGatewayConfigScaffold(root);
    const mode = fs.statSync(path.join(root, 'gateway', 'config', 'secrets.env')).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it('reports that a scaffolded policy still has no usable credential', () => {
    expect(ensureGatewayConfigScaffold(root).needsCredentials).toBe(true);
  });

  it('stops reporting once a credential is filled in', () => {
    ensureGatewayConfigScaffold(root);
    fs.writeFileSync(path.join(root, 'gateway', 'config', 'secrets.env'), 'ANTHROPIC_API_KEY=sk-real\n');
    expect(ensureGatewayConfigScaffold(root).needsCredentials).toBe(false);
  });
});

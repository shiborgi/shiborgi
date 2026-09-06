/**
 * What a fresh clone needs before a gateway can run, created on first use.
 *
 * Two things have to exist and neither can be committed: an install secret,
 * and a policy document. Making the host create them means `git clone` →
 * start is a real path rather than a documented sequence of manual steps
 * someone will get wrong on the machine where it matters.
 *
 * The secret is generated, because a random value is exactly as good as any
 * other and nobody should have to invent one. The policy is scaffolded from
 * the tracked example, because its CONTENT is a decision — which model, which
 * key — that only the operator can make. So the secret is silently created and
 * the policy is created empty-ish and announced.
 *
 * Both are create-if-absent and never rewritten. An install that has been
 * running must keep the secret it has: rotating it would invalidate the token
 * every live session is holding, and the failure would look like a broken
 * gateway rather than a rotated key.
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { GATEWAY_SECRET_ENV, generateGatewaySecret } from './gateway-identity.js';
import { log } from './log.js';

export function gatewayConfigDir(projectRoot: string = process.cwd()): string {
  return path.join(projectRoot, 'gateway', 'config');
}

/**
 * The install secret, generating and persisting one if this clone has none.
 *
 * Appended rather than upserted: a key already present is the answer, and
 * rewriting `.env` in place risks disturbing anything else an operator put
 * there.
 */
export function ensureGatewaySecret(projectRoot: string = process.cwd()): string {
  const existing = readEnvFile([GATEWAY_SECRET_ENV], projectRoot)[GATEWAY_SECRET_ENV];
  if (existing) return existing;

  const secret = generateGatewaySecret();
  const envPath = path.join(projectRoot, '.env');
  const prefix = fs.existsSync(envPath) && !fs.readFileSync(envPath, 'utf-8').endsWith('\n') ? '\n' : '';
  fs.appendFileSync(
    envPath,
    `${prefix}\n# Identifies this install's agents to its gateway. Generated once; rotating it\n` +
      `# invalidates the token every live session holds.\n${GATEWAY_SECRET_ENV}=${secret}\n`,
    { mode: 0o600 },
  );
  try {
    fs.chmodSync(envPath, 0o600);
  } catch {
    /* pre-existing file with other ownership — the append already succeeded */
  }
  log.info('Generated a gateway install secret', { file: '.env', key: GATEWAY_SECRET_ENV });
  return secret;
}

export interface ScaffoldResult {
  /** Files created by this call. Empty when everything was already present. */
  created: string[];
  /** True when the policy still holds no usable credential. */
  needsCredentials: boolean;
}

/**
 * Create `gateway.json` and `secrets.env` from their tracked examples.
 *
 * `secrets.env` is written 0600: it is the one file in the tree that holds
 * live credentials, and the gateway mounts it read-only.
 */
export function ensureGatewayConfigScaffold(projectRoot: string = process.cwd()): ScaffoldResult {
  const dir = gatewayConfigDir(projectRoot);
  const created: string[] = [];

  const files: Array<{ from: string; to: string; mode: number }> = [
    { from: 'gateway.example.json', to: 'gateway.json', mode: 0o644 },
    { from: 'secrets.example.env', to: 'secrets.env', mode: 0o600 },
  ];

  for (const file of files) {
    const target = path.join(dir, file.to);
    if (fs.existsSync(target)) continue;
    const source = path.join(dir, file.from);
    if (!fs.existsSync(source)) continue;
    fs.copyFileSync(source, target);
    fs.chmodSync(target, file.mode);
    created.push(path.join('gateway', 'config', file.to));
  }

  // "Present but empty" is the state a scaffold leaves behind, and it is the
  // one worth naming: the gateway will start, answer liveness, and refuse
  // every model call with a message about a missing secret. Saying so here
  // turns that into an expected next step instead of a puzzle.
  let needsCredentials = false;
  const secretsPath = path.join(dir, 'secrets.env');
  if (fs.existsSync(secretsPath)) {
    const values = fs
      .readFileSync(secretsPath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('#'))
      .map((line) => line.slice(line.indexOf('=') + 1).trim());
    needsCredentials = values.length === 0 || values.every((value) => value === '');
  }

  if (created.length > 0) {
    log.info('Scaffolded gateway configuration', { created });
  }
  if (needsCredentials) {
    log.warn(
      'The gateway has no upstream credentials yet — fill gateway/config/secrets.env ' +
        'and point gateway/config/gateway.json at the model you want',
    );
  }
  return { created, needsCredentials };
}

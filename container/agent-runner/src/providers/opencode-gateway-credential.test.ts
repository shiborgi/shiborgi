/**
 * The OpenAI-compatible transport's credential, when this install's gateway
 * (not OneCLI) is the egress path.
 *
 * `opencode.ts` is a vendored file from the `providers` registry branch; the
 * one line this pins — `apiKey: process.env.OPENAI_API_KEY || 'placeholder'`
 * — is a deliberate local divergence from the registry copy, not something a
 * `/update-skills` refresh should silently revert. See the comment beside it
 * in `opencode.ts` for why: this install's gateway is a direct endpoint the
 * agent calls, not a MITM proxy that rewrites the header on the wire, so the
 * literal credential the client sends is the one that has to identify it.
 *
 * A separate file rather than an addition to the vendored `opencode.config.test.ts`
 * so a re-sync from the registry branch overwrites that file cleanly without
 * taking this assertion down with it.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { buildOpenCodeConfig } from './opencode.js';

const ENV_KEYS = ['OPENCODE_PROVIDER', 'OPENCODE_MODEL', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function openaiEntry(config: Record<string, unknown>): Record<string, unknown> {
  return (config.provider as Record<string, Record<string, unknown>>).openai;
}

describe('OpenAI-compatible transport credential', () => {
  it('sends the gateway identity token when OPENAI_API_KEY is set', () => {
    process.env.OPENCODE_PROVIDER = 'openai';
    process.env.OPENCODE_MODEL = 'openai/default';
    process.env.ANTHROPIC_BASE_URL = 'http://192.168.128.9:8080/v1';
    process.env.OPENAI_API_KEY = 'ncl.ag-bartender.deadbeefdeadbeefdeadbeefdeadbeef';

    const entry = openaiEntry(buildOpenCodeConfig({}));

    expect(entry.options).toEqual({
      apiKey: 'ncl.ag-bartender.deadbeefdeadbeefdeadbeefdeadbeef',
      baseURL: 'http://192.168.128.9:8080/v1',
    });
  });

  it('falls back to the registry default when no gateway token is injected', () => {
    process.env.OPENCODE_PROVIDER = 'openai';
    process.env.OPENCODE_MODEL = 'openai/default';
    process.env.ANTHROPIC_BASE_URL = 'https://inference.example.test/v1';
    delete process.env.OPENAI_API_KEY;

    const entry = openaiEntry(buildOpenCodeConfig({}));

    expect(entry.options).toEqual({ apiKey: 'placeholder', baseURL: 'https://inference.example.test/v1' });
  });
});

/**
 * Dependency guard for the pi-cli integration point (host tree, vitest).
 *
 * add-pi installs `@earendil-works/pi-coding-agent` globally in the agent
 * container image via `container/cli-tools.json`. A globally-installed CLI
 * binary is not importable or typed, so neither `tsc` nor a runtime import
 * can catch its removal — only the container image build would, and the
 * skill's validate step does not rebuild the image in CI. This structural
 * test stands in for that build leg: it parses `container/cli-tools.json`
 * (one repo-root level up from this test, walked from any install location)
 * and asserts the `@earendil-works/pi-coding-agent` row is present with a
 * pinned version. Drop or drift the pin and this goes red.
 *
 * Pinning matters here beyond reproducibility: pi's CLI evolves in lockstep
 * with the SDK it ships — the `--mode rpc` wire format and the
 * `AgentSession` event schema both change across majors. An unpinned
 * `latest` would silently upgrade past a known-good version and break RPC
 * consumers. The test therefore rejects `@latest` and rejects any non-
 * semver value.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

function cliToolsJson(): { name: string; version: string; onlyBuilt?: boolean }[] {
  // Walk up from this test file to the repo root, since the test may be
  // copied into src/ or remain in the skill folder — both must work.
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'container', 'cli-tools.json');
    if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, 'utf8'));
    dir = path.dirname(dir);
  }
  throw new Error('container/cli-tools.json not found walking up from ' + __dirname);
}

describe('container/cli-tools.json installs the pi coding-agent CLI', () => {
  const manifest = cliToolsJson();
  const pi = manifest.find((t) => t.name === '@earendil-works/pi-coding-agent');

  it('declares @earendil-works/pi-coding-agent as a pinned tool (not latest)', () => {
    expect(
      pi,
      '@earendil-works/pi-coding-agent entry missing from container/cli-tools.json',
    ).toBeDefined();
    expect(pi!.version).toBeTruthy();
    expect(pi!.version).not.toBe('latest');
    expect(pi!.version).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
  });

  it('does not need onlyBuilt — pi is pure JS over cross-spawn + undici', () => {
    // Defensive: catch accidental enablement that would let pnpm try to
    // run a non-existent pi postinstall and break the build.
    expect(pi!.onlyBuilt ?? false).toBe(false);
  });
});

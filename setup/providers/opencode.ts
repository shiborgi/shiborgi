/**
 * OpenCode provider setup — no interactive auth step of its own.
 *
 * Unlike Codex, OpenCode's credentials never touch setup: they live in this
 * install's gateway (`gateway/config/secrets.env` + `gateway.json`), which is
 * per-project configuration the operator owns directly, not something a setup
 * wizard should walk through or vault. Registering `runAuth` here — even as
 * guidance-only — is what keeps the wizard from falling back to the standard
 * Claude/Anthropic auth flow when OpenCode is the picked provider (see the
 * `providerEntry?.runAuth` branch in setup/auto.ts): without it, picking
 * OpenCode would prompt for an Anthropic account it does not need.
 *
 * Label and hint are pinned to the `add-opencode` skill descriptor's
 * frontmatter (`registry.test.ts` checks the two stay in sync).
 */
import * as p from '@clack/prompts';

import { brandBody } from '../lib/theme.js';
import { registerSetupProvider } from './registry.js';

registerSetupProvider({
  value: 'opencode',
  label: 'OpenCode',
  hint: 'Open-source provider router',
  async runAuth() {
    p.log.info(
      brandBody(
        "OpenCode's model and credentials are per-project, not set up here. Fill in " +
          'gateway/config/secrets.env (the upstream key) and gateway/config/gateway.json ' +
          '(which model it routes to), then set OPENCODE_PROVIDER and OPENCODE_MODEL in .env ' +
          'to match. See .claude/skills/add-opencode/SKILL.md for the full reference.',
      ),
    );
  },
});

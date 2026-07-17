---
name: add-pi
description: Use the Pi coding agent instead of Claude Code. Per-group via `ncl groups config update --provider pi`; host passes `PI_PROVIDER`, `PI_MODEL`, and `ANTHROPIC_BASE_URL` when spawning containers. Pi runs in --mode rpc over JSONL.
---

# Pi agent provider

NanoClaw runs agents in a long-lived **poll loop** inside the container. The backend is selected per agent group by the **`provider`** key in that group's `container.json` (materialized from the `container_configs` table) — set it with `ncl groups config update --provider pi`. Default is `claude`.

Trunk ships with only the `claude` provider baked in. This skill adds the **Pi** provider, which talks to the `@earendil-works/pi-coding-agent` CLI in `--mode rpc` over JSONL. Unlike OpenCode (which the upstream `providers` branch ships), **Pi's provider is fully in-tree** — host config, container provider, and CLI manifest entry all land here. No fetch-from-branch required.

Apply runs the apply block below: the format mirrors the other add-* skills. Every directive is idempotent so re-runs are safe.

## Why in-tree, not from the `providers` branch

The `providers` branch ships OpenCode as a benchmark for non-Claude backends. Pi is new enough and small enough that an in-tree add is cleaner — the skill is the full distribution. If a future `feat/pi-provider` branch consolidates Pi the same way OpenCode lives, this skill becomes a `git fetch … && cp … …` like add-opencode is. Today that's not warranted.

## Install

### Pre-flight

If all of the following are already present, skip to **Build and validate**:

- `src/providers/pi.ts`
- `container/agent-runner/src/providers/pi.ts`
- `src/providers/pi-registration.test.ts`
- `container/agent-runner/src/providers/pi-registration.test.ts`
- `import './pi.js';` line in `src/providers/index.ts`
- `import './pi.js';` line in `container/agent-runner/src/providers/index.ts`
- `@earendil-works/pi-coding-agent` in `container/agent-runner/package.json`
- `{ "name": "@earendil-works/pi-coding-agent", "version": "0.80.10" }` in `container/cli-tools.json`
- `src/pi-dockerfile.test.ts`

Missing pieces — continue below. All steps are idempotent; re-running is safe.

### 1. Copy the pi provider files

Wholesale copies (owned entirely by this skill):

```bash
SKILL=.claude/skills/add-pi
cp $SKILL/resources/pi.ts                                              src/providers/pi.ts
cp $SKILL/resources/container-pi.ts                                   container/agent-runner/src/providers/pi.ts
cp $SKILL/resources/pi-registration.test.ts                           src/providers/pi-registration.test.ts
cp $SKILL/resources/container-pi-registration.test.ts                container/agent-runner/src/providers/pi-registration.test.ts
cp $SKILL/resources/pi-dockerfile.test.ts                             src/pi-dockerfile.test.ts
```

### 2. Append the self-registration imports

Each barrel gets one line appended at the end. Skip if the line is already present.

`src/providers/index.ts`:

```typescript
import './pi.js';
```

`container/agent-runner/src/providers/index.ts`:

```typescript
import './pi.js';
```

### 3. Add the agent-runner dependency

Pinned. **Do not** `bun update` — bump deliberately. Use `0.80.10` (or whatever the current `latest` dist-tag is — verify at https://registry.npmjs.org/@earendil-works/pi-coding-agent before applying, and update both this step and step 4 in lockstep). Pi pins `<22.19.0` engines in newer minors and `<20.6.0` in older ones; the shiborgi image runs `node:22-slim`, so `>=22.19.0` is fine.

```bash
cd container/agent-runner && bun add @earendil-works/pi-coding-agent@0.80.10 && cd -
```

No postinstall — pi is a pre-built JS package (the tarball ships `dist/` already populated). The build/install path does not need `--ignore-scripts`; just adding the dep is enough.

### 4. Add the `@earendil-works/pi-coding-agent` row to `container/cli-tools.json`

This is the Dockerfile installation seam — `install-cli-tools.sh` reads the manifest at image build time and runs `pnpm install -g <name>@<version>` for each row.

Append after the existing rows, preserving the order of "most stable first":

```json
{ "name": "@earendil-works/pi-coding-agent", "version": "0.80.10" }
```

Note the absence of `"onlyBuilt": true` — pi has no native postinstall; letting pnpm try one would be a build break rather than a runtime fix. The Dockerfile guard in step 6 asserts this defensively.

### 5. Build and validate

```bash
pnpm run build                                                        # host typecheck
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit        # container typecheck
pnpm exec vitest run src/providers/pi-registration.test.ts            # host registration guard
pnpm exec vitest run src/pi-dockerfile.test.ts                        # cli-tools.json install guard
cd container/agent-runner && bun test src/providers/pi-registration.test.ts && cd -  # container registration guard
```

All four must be clean before proceeding. Each guards a distinct integration point:

- **`src/providers/pi-registration.test.ts`** (host, vitest) imports the real host barrel and asserts `listProviderContainerConfigNames()` contains `pi`. It goes red if the `import './pi.js';` line in `src/providers/index.ts` is deleted or drifts, or if that barrel fails to evaluate.
- **`container/agent-runner/src/providers/pi-registration.test.ts`** (container, bun:test) imports the real container barrel and asserts `listProviderNames()` contains `pi`. It goes red if the `import './pi.js';` line in `container/agent-runner/src/providers/index.ts` is deleted or drifts. Because the container barrel is imported unmocked, it pulls in `pi.ts`, which imports nothing exotic at top level — so this test is independent of whether pi is actually installed at test time.
- **`src/pi-dockerfile.test.ts`** parses `container/cli-tools.json` (walked from the install location) and asserts the pinned `@earendil-works/pi-coding-agent` row is present with a semver-pinned version (rejecting `latest`). The `pi` binary is globally installed by the image build and not importable, so it is guarded by this structural test + the image build, not by `tsc`.
- **`pnpm run build`** type-checks the host provider's consumption of the host-side container-config registry; the container typecheck does the same for the container provider against the agent-runner core APIs.

### 6. Propagate to existing per-group overlays

Each agent group has a live source overlay at `data/v2-sessions/<group-id>/agent-runner-src/providers/` that **overrides the image at runtime**. This overlay is created when the group is first wired and never auto-updated by image rebuilds. Any group that already existed before this skill ran needs the new file copied in manually.

```bash
for overlay in data/v2-sessions/*/agent-runner-src/providers/; do
  [ -d "$overlay" ] || continue
  cp container/agent-runner/src/providers/pi.ts "$overlay"
  cp container/agent-runner/src/providers/index.ts "$overlay"
  echo "Updated: $overlay"
done
```

The next container spawn for that group picks up the new provider — no `ncl groups restart` needed (the spawn re-reads from the overlay).

## Configuration

### Host `.env` (typical — Anthropic provider, native proxy)

Pi supports `anthropic` as a first-class provider; for that case, the credential lives in `.env` exactly like the Claude SDK:

```env
NANOCLAW_NATIVE_CREDENTIALS=true
ANTHROPIC_API_KEY=sk-ant-...
PI_PROVIDER=anthropic
PI_MODEL=claude-sonnet-4-20250514
```

`use-native-credential-proxy` (the skill that materializes `ANTHROPIC_API_KEY` as a `-e` for the container) applies on the Claude SDK side and also reaches pi because pi reads the same env var for the `anthropic` provider. No extra credential wiring.

Setting `PI_PROVIDER` and `PI_MODEL` is optional — pi's interactive `/model` lets you switch at runtime, and the constructor falls back to those env values when the host doesn't pass an explicit `model` in `agent.options`.

### Anthropic with custom endpoint (`ANTHROPIC_BASE_URL`)

Pi reads `ANTHROPIC_BASE_URL` natively. The host provider forwards it into the container env when `.env` declares it:

```env
NANOCLAW_NATIVE_CREDENTIALS=true
ANTHROPIC_BASE_URL=https://your-proxy.example/v1
PI_PROVIDER=anthropic
```

`ANTHROPIC_BASE_URL` is the only Anthropic-specific override pi consumes — the host doesn't forward other pi provider configs because they live in pi's own auth surface (`~/.pi/agent/auth.json`).

### Non-Anthropic providers (OpenAI, OpenRouter, Google, …)

Pi reads its own env vars and/or `~/.pi/agent/auth.json` for everything else. The host provider does not forward those — operators place credentials in `.env` *as pi reads them* (e.g. `OPENAI_API_KEY`) and the container reads them straight off the process env that the host already passed in.

```env
PI_PROVIDER=openai
PI_MODEL=openai/gpt-5.1
OPENAI_API_KEY=sk-...
```

Pi's auth precedence (from pi.dev/docs/latest/providers): CLI `--api-key` flag → `auth.json` → env → custom providers in `models.json`. The `auth.json` route is the recommended one for repeated ops because env interpolation avoids leaking the literal key into the image.

### Select the provider

Per group, from the host:

```bash
ncl groups config update --id <group-id> --provider pi
ncl groups restart --id <group-id>
```

`ncl groups config update --provider` writes the `provider` value into the `container_configs` table; the host materializes it into `groups/<folder>/container.json` at spawn time and the in-container runner reads `provider` from there (defaulting to `claude`). The restart picks up the change. Switching is an operator action — run it from the host. Memory does NOT carry over automatically between providers — run `/migrate-memory` to carry it across.

Extra MCP servers still come from **`NANOCLAW_MCP_SERVERS`** / `container_config.mcpServers` on the host; the runner merges them into the same `mcpServers` object passed to **both** Claude and Pi providers.

## Operational notes

- **RPC framing.** Pi uses strict JSONL with LF-only record delimiters — even though Node `readline` is convenient, do not use it on the producer/consumer sides; its Unicode-separator handling can split inside JSON strings. The provider's `jsonlLines()` helper splits on `\n` only and strips trailing `\r` for compatibility.
- **Backpressure is implicit.** The provider queues events in memory and the poll-loop pulls from `events`. A flood of `message_update` deltas is throttled by the consumer's pace — no need for a separate channel.
- **Continuation semantics.** Pi identifies sessions by an internal id, distinct from Claude's UUID. The provider surfaces the `session` header line as the `init.continuation` event the poll-loop captures. When the same session resumes, pi accepts that id; the provider doesn't have to round-trip it.
- **`--no-session`.** The provider always passes `--no-session` because the agent-runner has its own session DB (inbound.db + outbound.db) for resume. Running pi's interactive `--session` flag would put a parallel session store on disk, which would diverge from the nanoclaw session state and confuse the resume path. If you want pi's on-disk session history, drop `--no-session` here; the trade-off is yours.
- **`registerMemorySessionHook`.** Pi's `~/.pi/agent/AGENTS.md` is the canonical memory location; the host already mounts that file as part of the shared agent-runner surface, so the provider no-ops the memory hook. If a future minor of pi grows a richer memory API, expand the no-op here.

## Next Steps

The registration and Dockerfile guards in step 5 verify the wiring. To confirm an end-to-end round-trip, switch a test group with `ncl groups config update --id <group-id> --provider pi && ncl groups restart --id <group-id>`, register the matching provider credential (`.env` for Anthropic; `auth.json` for everyone else), and send a message. A clean exchange returns the model's reply with no `Unknown provider: pi` error in the logs.

To remove this provider, see `REMOVE.md`.

---
name: apple-container
description: Switch NanoClaw's container runtime from Docker to Apple Container (macOS Apple Silicon, CLI 1.1.0+). Uses /use-native-credential-proxy for credentials — no Docker or OneCLI required. Idempotent; defaults to Docker when not chosen.
---

# /apple-container — Switch to Apple Container runtime

Reconfigures NanoClaw to run its agent containers on Apple Container instead
of Docker. macOS-only; presupposes the `container` CLI is already installed.

The Apply block below is a sequence of `nc:` directive fences: an agent
reads the prose and applies them, and a parser can apply them
deterministically from the same document. Every directive is idempotent,
so the whole skill is safe to re-run; anything a parser can't apply falls
back to the prose beside it.

## Why this skill requires `/use-native-credential-proxy` first

Apple Container 1.1.0 is a micro-VM-based runtime, not a Linux kernel. There
is no `--internal` Docker network on it, so the OneCLI egress lockdown that
NanoClaw uses to route agent traffic through a controlled gateway cannot be
established on Apple Container. That makes the OneCLI gateway (Docker
Compose stack) operationally fragile in this runtime: Docker Desktop would
have to be running in parallel at all times to host a local OneCLI
gateway, with a TCP forwarder bridging the Apple bridge network and the
Docker bridge network.

The simplest, runtime-agnostic credential path is `/use-native-credential-proxy`:
it reads the Anthropic credential from `.env` and injects it into the
container as standard environment variables, which the Claude Agent SDK
reads natively. No Docker, no OneCLI, no proxy.

**Pre-flight refuses to apply the runtime switch without it.** If you want
OneCLI-based credentials on Apple Container anyway, you can point
`ONECLI_URL` to a remote gateway hosted elsewhere (see
`/use-native-credential-proxy` for the `.env` semantics; `/init-onecli`
already supports `--remote-url`), but this skill doesn't try to manage that
path — it only requires the native proxy.

## Phase 1: Pre-flight

### Platform check

```nc:run effect:check
[[ "$OSTYPE" == darwin* ]] || { echo "Apple Container is macOS-only. Aborting."; exit 1; }
```

### CLI presence (the `container` CLI must already be installed)

This skill does **not** install Apple Container. Validate the installed
version is 1.1.0 or later — earlier majors do not match the assumed
run/spawn semantics used by `src/container-runtime.ts` after the patch.

```nc:run capture:cli_version effect:fetch
container --version 2>/dev/null | head -1
```

```nc:run effect:check
[[ -n "$(command -v container)" ]]
```

If `container` is missing, tell the user: *"Install Apple Container
(https://github.com/apple/container — `brew install container`) and start
its system + builder services, then re-run `/apple-container`."* and stop.

### Daemons up

```nc:run effect:step
container system status || container system start
container builder status || container builder start
```

If either refuses to come up, log the output, surface the error verbatim
and stop — without these, no agent container can be built or run.

### Required prerequisite: `/use-native-credential-proxy` must already be applied

```nc:run effect:check
test -f src/native-credential-proxy.ts \
  && grep -q 'nativeCredentialEnvArgs' src/container-runner.ts \
  && grep -q '^NANOCLAW_NATIVE_CREDENTIALS=true' .env \
  && grep -qE '^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)=' .env
```

If this check fails, stop and tell the user exactly what to do:

```nc:operator
Para rodar em Apple Container sem Docker/OneCLI, o caminho de credencial é o native credential proxy. Aplique-o antes de continuar:

  /use-native-credential-proxy

Por quê: Apple Container 1.1.0 não tem rede `--internal`, então OneCLI gateway (Docker Compose) não sobe automaticamente, e Docker Desktop sidecar é operacionalmente frágil. Native proxy injeta a chave Anthropic via -e direto no container — trade-off explícito de segurança já documentado em /use-native-credential-proxy.

Quando /use-native-credential-proxy estiver aplicado (arquivo copiado, NANOCLAW_NATIVE_CREDENTIALS=true, e um dos tokens no .env), re-rode /apple-container.
```

The check is non-negotiable: without a credential, the container will
spawn but the agent cannot reach the API, and debugging that on a fresh
install is wasted tokens.

### Idempotency: already applied?

```nc:run effect:check
grep -q '^CONTAINER_RUNTIME=container' .env
```

If yes, the runtime is already flipped. Use AskUserQuestion:

1. **Keep** — no-op, exit cleanly.
2. **Reconfigure** — re-detect bridge IP, re-apply any patch that drifted.
3. **Remove** — execute `REMOVE.md` to revert to Docker, then exit.

If the user picks Remove, do not re-apply — just run REMOVE.md and stop.

### Arch note

Apple Container is supported on both Apple Silicon and Intel Macs but is
optimized for the former. The skill does not enforce this, but log it
honestly:

```nc:run effect:fetch
uname -m
```

## Phase 2: Apply code changes

Four small, idempotent patches. Each touches one file. Order matters only
because `pnpm run build` is run once at the end: the patches are
independent at the source level.

### 2.1 Replace `src/container-runtime.ts`

This is the runtime switch. The change converts the hard-coded
`CONTAINER_RUNTIME_BIN = 'docker'` constant into an env-driven factory,
branches the four pure functions (`hostGatewayArgs`, `stopContainer`,
`ensureContainerRuntimeRunning`, `cleanupOrphans`) on the runtime, and
adds one helper export (`getAppleBridgeIp`) for the bridge network IP
that `hostGatewayArgs` consults in Apple mode. There is also one new
import (`execFileSync` from `child_process`) and one new constant export
(`APPLE_CONTAINER_INSTALL_LABEL_PREFIX`) — small, mechanical.

The skill ships the canonical post-patch file at
`resources/container-runtime.ts`. Use it as the source of truth — the
diff vs. trunk is small but intermingled, so an overwrite is cleaner
than a patch and avoids drift when `git apply --check` fails:

```nc:run effect:fallback
cp .claude/skills/apple-container/resources/container-runtime.ts src/container-runtime.ts
cp .claude/skills/apple-container/resources/container-runtime.test.ts src/container-runtime.test.ts
```

The two files together: the source defines the new behavior, the test
file is updated with Apple-Container cases (Docker-mode cases remain —
they verify the existing path still works). The test file covers both
modes; it is the canary that catches a runtime-branch regression on
either side.

### 2.2 Patch `src/egress-lockdown.ts` (and add `egress-lockdown.test.ts`)

Gate the egress lockdown off when running on Apple Container — there is
no `--internal` bridge network there, so the lockdown cannot be
established. With the native credential proxy in use, the container has
default egress; that is the documented trade-off of
`/use-native-credential-proxy`.

```nc:run effect:patch
git apply --check .claude/skills/apple-container/resources/patches/egress-lockdown.patch && git apply .claude/skills/apple-container/resources/patches/egress-lockdown.patch
```

The egress lockdown has no test file in trunk (verified by `find` —
only `src/egress-lockdown.ts` exists). The runtime branch added by this
patch is the most security-relevant behavior the skill introduces, so
add the test file in the same step:

```nc:run effect:fallback
cp .claude/skills/apple-container/resources/egress-lockdown.test.ts src/egress-lockdown.test.ts
```

The test covers: (1) lockdown off in Apple Container returns `false`
from `ensureEgressNetwork()` without touching Docker networks; (2)
lockdown on in Docker path requires the gateway container to be
reachable and throws `EgressLockdownError` when it isn't; (3)
`egressNetworkArgs()` returns the same Docker-network args the
container-runner consumes.

### 2.3 Patch `setup/container.ts`

Extend `parseArgs` to accept `--runtime container` (it currently rejects
with `unknown_runtime`). When the runtime is `container`, use the Apple
CLI for both build and the smoke run test.

```nc:run effect:patch
git apply --check .claude/skills/apple-container/resources/patches/setup-container.patch && git apply .claude/skills/apple-container/resources/patches/setup-container.patch
```

### 2.4 Patch `setup/service.ts`

Propagate `CONTAINER_RUNTIME` (read from `.env`) into the launchd plist
and systemd unit's EnvironmentVariables. Without this, a `launchctl
kickstart -k` after editing `.env` reverts to Docker — the env var is
captured at plist-write time and re-read on every service load only if the
plist changed.

```nc:run effect:patch
git apply --check .claude/skills/apple-container/resources/patches/service-env.patch && git apply .claude/skills/apple-container/resources/patches/service-env.patch
```

### 2.5 Wire bridge autodetect in `src/index.ts`

Add a single block in `main()`, right after the existing
`ensureContainerRuntimeRunning()` / `cleanupOrphans()` lines (those are
the container-runtime block — keep them adjacent). The block is a no-op
unless `CONTAINER_RUNTIME === 'container'`, so the Docker path is
byte-identical with the patch reverted.

```nc:run effect:patch
git apply --check .claude/skills/apple-container/resources/patches/index-bridge-detect.patch && git apply .claude/skills/apple-container/resources/patches/index-bridge-detect.patch
```

For source-level inspection (so the agent sees the intended placement
alongside the prose), the patch inserts these lines right after
`cleanupOrphans();`:

```typescript
  // Apple Container: resolve host.docker.internal gateway IP from the
  // bridge interface Apple Container 1.1.0 creates. Persist in env so
  // container-runtime.ts can reuse it on every spawn without re-running
  // ifconfig. Skipped entirely when CONTAINER_RUNTIME != 'container'.
  if (CONTAINER_RUNTIME_BIN === 'container') {
    const ip = getAppleBridgeIp();
    if (ip) {
      process.env.APPLE_CONTAINER_BRIDGE_IP = ip;
      log.info('Apple Container bridge detected', { ip });
    } else {
      log.warn(
        'Apple Container bridge100 interface not found — host.docker.internal may not resolve inside the container',
      );
    }
  }
```

`getAppleBridgeIp` is added to the canonical `src/container-runtime.ts`
written in step 2.1, alongside `CONTAINER_RUNTIME_BIN` itself — same
import statement, no new module to wire up.

## Phase 3: Write the runtime flag (and bridge IP) to `.env`

Use the same write-back helper every other skill uses (`init-onecli`,
`use-native-credential-proxy`): grep + sed-if-present + append-if-not.
Never clobber a hand-edited value.

```nc:run effect:external
touch .env && grep -v '^CONTAINER_RUNTIME=' .env > .env.tmp && printf 'CONTAINER_RUNTIME=container\n' >> .env.tmp && mv .env.tmp .env
```

```nc:run capture:bridge_ip effect:fetch
ifconfig bridge100 2>/dev/null | awk '/inet /{print $2; exit}'
```

Two scenarios below cover both shapes:
- **bridge-present**: the ifconfig probe returns the bridge100 IP —
  the runtime picks it up and persists it.
- **bridge-missing**: ifconfig fails (interface not yet provisioned —
  Apple Container lazily creates the VM on first spawn). The runtime
  path still completes; the env key stays absent and Phase 5's
  runtime warning surfaces.

The Apply block below always calls `ifconfig bridge100` once and lets
the captured value stand. Two `.env` writes are gated by `when:` to
keep the safe behavior on both paths:

```nc:run effect:external
touch .env && grep -v '^APPLE_CONTAINER_BRIDGE_IP=' .env > .env.tmp; APPLE_LINE=""; if [ -n "{{bridge_ip}}" ]; then APPLE_LINE="APPLE_CONTAINER_BRIDGE_IP={{bridge_ip}}"; fi; [ -n "$APPLE_LINE" ] && printf '%s\n' "$APPLE_LINE" >> .env.tmp; mv .env.tmp .env
```

No `when:` guard here — the inline shell conditional handles both
shapes. Simpler, and one fewer binding for the conformance gate to
verify.

## Phase 4: Build, test, and validate

Build is the first leg — it typechecks the patches against the rest of
the trunk and proves the runtime branch compiles in both modes.

```nc:run effect:build
pnpm run build
```

Then the runtime + lockdown tests:

```nc:run effect:test
pnpm exec vitest run src/container-runtime.test.ts src/egress-lockdown.test.ts
```

`src/container-runtime.test.ts` is overwritten in step 2.1 with both
the existing Docker cases and new Apple-Container cases. The new cases
mock `process.env.CONTAINER_RUNTIME = 'container'` and assert the
Apple-branch behavior: bridge-IP injection, `container stop`,
JSON-list-based orphan cleanup, `container system status` health.
`src/egress-lockdown.test.ts` is new in this skill — it covers the gate
added in step 2.2 (lockdown off in Apple Container) and the existing
Docker behavior. Together they pass on either runtime; they are the
canonical coverage for the seam.

## Phase 5: Restart and verify

Restart picks up the new plist/unit (which carries `CONTAINER_RUNTIME`),
so the env var reaches the host process — `container-runtime.ts` reads it
at module load.

```nc:run effect:restart
bash setup/lib/restart.sh
```

Smoke the runtime: build the agent image directly with the `container`
CLI (so a `pnpm run setup` later can also use it), and verify the
inspector agrees on the env-var injection that the native credential
proxy will add at runtime.

```nc:run effect:smoke
container build -t "$(. setup/lib/install-slug.sh && container_image_base)" container/ 2>&1 | tail -5
container run --rm "$(. setup/lib/install-slug.sh && container_image_base)" /bin/echo "Container OK"
```

Then send a test message in any wired chat. The agent should respond
using the Anthropic credential threaded in via `-e` from
`/use-native-credential-proxy`.

## Cross-references

- **`/use-native-credential-proxy`** — required prerequisite. Reads
  `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` from `.env` and threads
  into the container as `-e`.
- **`/init-onecli`** — orthogonal. Unaffected by this skill; users who
  want to point at a remote OneCLI gateway can set `ONECLI_URL` directly
  in `.env` — this skill does not touch that path.
- **`/add-whatsapp`** and **`/add-dashboard`** — orthogonal. Both are
  host-side wiring that does not consult the container runtime.

## Removal

See `REMOVE.md`. It removes `.env` lines the skill added, reverts the
patches with `git apply -R`, rebuilds, and restarts. Safe to re-run.

## Troubleshooting

**`container system status` fails:** the Apple Container background
services aren't running. The CLI is installed but not started. Open
Docker Desktop's Apple Container integration, or run `container system
start` manually.

**`container builder status` fails:** same as above — or the builder
service crashed. The CLI is itself a small CLI wrapper; the actual Linux
container build kernel lives in a separate service. Try
`container builder start`; if it refuses, reinstall Apple Container.

**Bridge IP never appears (`APPLE_CONTAINER_BRIDGE_IP` empty in `.env`):
** `ifconfig bridge100` returned nothing. The Apple Container VM likely
hasn't been initialized (run any `container run` first to force VM bring-up
— Apple Container lazily provisions the VM on first spawn, then keeps it
warm). After the first `container run`, re-run `/apple-container` and the
bridge IP will populate.

**Container builds successfully but agent gets 401 from Anthropic:**
`/use-native-credential-proxy` did not apply the credential to the
container. Check: `container inspect <name-or-id> | grep -E 'ANTHROPIC|CLAUDE'`.
If empty, the wiring in `src/container-runner.ts` got reverted — re-apply
`/use-native-credential-proxy`.

**Service started but uses Docker anyway after restart:** the launchd
plist / systemd unit didn't pick up `CONTAINER_RUNTIME`. Verify the
patch in `setup/service.ts` applied (`grep CONTAINER_RUNTIME setup/service.ts`)
and re-run `pnpm exec tsx setup/index.ts --step service`.

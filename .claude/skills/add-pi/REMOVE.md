# Remove /add-pi

Reverts the Pi provider installation. Idempotent — every step tolerates a
half-removed state.

## 1. Revert the source files

```bash
SKILL=.claude/skills/add-pi
# Files created by this skill:
rm -f src/providers/pi.ts
rm -f src/providers/pi-registration.test.ts
rm -f container/agent-runner/src/providers/pi.ts
rm -f container/agent-runner/src/providers/pi-registration.test.ts
rm -f src/pi-dockerfile.test.ts
```

## 2. Revert the barrel imports

```bash
# src/providers/index.ts — drop the `import './pi.js';` line
sed -i.bak "/^import '\.\/pi\.js';$/d" src/providers/index.ts && rm -f src/providers/index.ts.bak

# container/agent-runner/src/providers/index.ts — same
sed -i.bak "/^import '\.\/pi\.js';$/d" container/agent-runner/src/providers/index.ts && rm -f container/agent-runner/src/providers/index.ts.bak
```

The `sed -i.bak` pattern lets `add-pi` be re-run cleanly: idempotency survives the "already removed" case.

## 3. Revert `container/cli-tools.json`

The skill appended one row to the manifest. Drop it, preserving the order of the remaining rows:

```bash
node -e '
  const fs = require("fs");
  const path = "container/cli-tools.json";
  const tools = JSON.parse(fs.readFileSync(path, "utf8")).filter(
    (t) => t.name !== "@earendil-works/pi-coding-agent",
  );
  fs.writeFileSync(path, JSON.stringify(tools, null, 2) + "\n");
'
```

## 4. Drop the dependency from `container/agent-runner/package.json`

```bash
cd container/agent-runner && bun remove @earendil-works/pi-coding-agent && cd -
```

This rewrites `package.json` and the lockfile (`bun.lock`). If a future apply wants to bring Pi back, `bun add` will reinstall.

## 5. Propagate the revert to per-group overlays

Each existing group's source overlay (created the first time the group spawned) needs the pi file removed too — otherwise the next spawn will reference a missing barrel entry.

```bash
for overlay in data/v2-sessions/*/agent-runner-src/providers/; do
  [ -d "$overlay" ] || continue
  rm -f "$overlay/pi.ts"
  echo "Cleaned: $overlay"
done
```

If the overlay's `index.ts` was customized (it stays the same shape because the only change this skill made was the `import './pi.js';` line — bars already omitted it), no further action is needed.

## 6. Switch back to Claude for any group that was on Pi

The provider name in `container.json` (materialized from the `container_configs` table) is the only operator-visible state. Switch affected groups:

```bash
ncl groups config update --id <group-id> --provider claude
```

Repeat per group. Groups that were never switched are unaffected — they were never on Pi.

## 7. Rebuild and restart

```bash
pnpm run build
bash setup/lib/restart.sh
```

The service restart picks up the reverted barrels; `pnpm run build` ensures the host typecheck still passes with the deleted `pi.ts` file (the structural tests assert their absence by going red).

## 8. Verify

```bash
# pi should no longer appear in the host registry
grep -q "listProviderContainerConfigNames" src/providers/index.ts
pnpm exec vitest run src/providers/pi-registration.test.ts 2>&1 | tail -3
# Expected: test file is gone — Vitest reports "no test files found" for the path, NOT a failure.
```

If tests fail with "Cannot find module './provider-container-registry.js'", the barrel revert in step 2 left a stale import. Re-run step 2.

## After removal

The project is byte-identical to a fresh install of the in-tree skills without `/add-pi` applied. Subsequent runs of `/setup` or provider restart see `claude` as the only registered provider.

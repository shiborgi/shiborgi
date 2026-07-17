# Remove /apple-container

Reverts the runtime switch back to Docker and removes the artifacts
introduced by the skill. Safe to re-run — every step is idempotent and
uses `git apply -R`, so a half-removed state completes cleanly.

## 1. Revert the source patches

From the project root, with a clean working tree (or at least nothing
else touching these files):

```bash
SKILL=.claude/skills/apple-container
git apply -R $SKILL/resources/patches/egress-lockdown.patch || true
git apply -R $SKILL/resources/patches/setup-container.patch   || true
git apply -R $SKILL/resources/patches/service-env.patch      || true
git apply -R $SKILL/resources/patches/index-bridge-detect.patch || true
```

The `|| true` is intentional — a patch that was never applied fails
cleanly with `-R`, and we don't want one missing revert to block the
rest. After this step, `git diff` should show:
- `src/egress-lockdown.ts`: unchanged
- `setup/container.ts`: unchanged
- `setup/service.ts`: unchanged
- `src/index.ts`: unchanged

Replacing `src/container-runtime.ts` (overwritten in step 2.1 of the
skill) is a slightly different story. That file's diff is intermingled
throughout — recovering the exact pre-skill state from a multi-line
overwrite is fragile. The safer revert path is `git checkout HEAD --
src/container-runtime.ts`. If the file has changed since the skill
applied (other commits), capture the upstream version first:

```bash
git show HEAD:src/container-runtime.ts > /tmp/runtime-pre-skill.ts
# apply your local edits (if any) on top — typically none on this file
cp /tmp/runtime-pre-skill.ts src/container-runtime.ts
```

`src/container-runtime.test.ts` and `src/egress-lockdown.test.ts` are
the test files. `src/container-runtime.test.ts` was overwritten with
Apple-Container cases; `git checkout HEAD --` reverts it. The
`src/egress-lockdown.test.ts` is new in this skill — delete it:

```bash
git checkout HEAD -- src/container-runtime.ts src/container-runtime.test.ts
rm -f src/egress-lockdown.test.ts
```

## 2. Remove runtime flag from `.env`

```bash
cd "$PROJECT_ROOT"
grep -v '^CONTAINER_RUNTIME=' .env > .env.tmp && mv .env.tmp .env
grep -v '^APPLE_CONTAINER_BRIDGE_IP=' .env > .env.tmp && mv .env.tmp .env
```

## 3. Rebuild and restart

```bash
pnpm run build
bash setup/lib/restart.sh
```

The next `launchctl kickstart -k` (or `systemctl --user restart …`) re-
reads the launchd plist / systemd unit. Without `CONTAINER_RUNTIME` in
either, the host process falls back to Docker — `container-runtime.ts`
reads the env var at module load, and the default is `docker`.

## 4. Verify

```bash
docker ps --filter label=nanoclaw-install="$(_nanoclaw_install_slug)" --format '{{.Names}}'
# Expect the agent container running under Docker, not Apple Container.

grep CONTAINER_RUNTIME .env || echo "flag cleared"
```

If the flag remains in `.env`, step 2 didn't catch it — `grep -v` only
matches at start-of-line, so a `CONTAINER_RUNTIME=…` line that's been
indented would slip through. Inspect manually with `grep CONTAINER_RUNTIME .env`.

## Cleanup: skill folder

Deleting the skill folder is optional. Removing the source skills from
the tree doesn't help maintainers retroactively — keep the folder so
the runtime flip is reproducible later. If disk space matters:

```bash
rm -rf .claude/skills/apple-container
```

## After removal

The state of the project is byte-identical to a fresh install of the
skills (`add-whatsapp`, `add-dashboard`, `init-onecli`, `use-native-credential-proxy`)
without `/apple-container` applied. Subsequent runs of `/setup` or
`/init-first-agent` see Docker as the default runtime.

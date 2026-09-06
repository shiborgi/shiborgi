/**
 * Container runtime constants.
 *
 * This file used to claim that "all runtime-specific logic lives here so
 * swapping runtimes means changing one file" while the actual runtime logic —
 * spawn argv, mounts, hardening, kill/stop, orphan reaping — lived in
 * `container-runner.ts` and the egress module. That logic now lives behind the
 * driver seam (`src/drivers/`), which is what makes the claim true.
 *
 * What is left is the binary name, still needed by the few paths that shell a
 * runtime for something that is not a session: per-group image builds and the
 * Docker-path egress lockdown network.
 *
 * Defaults to `container` to match the default session driver, and follows
 * `CONTAINER_RUNTIME` — the same variable `container/build.sh` and
 * `container/pull.sh` read — so an install that moved to Docker moves these
 * paths with it instead of having one half address the other's image store.
 */

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = process.env.CONTAINER_RUNTIME ?? 'container';

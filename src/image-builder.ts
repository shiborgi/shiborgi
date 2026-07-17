/**
 * Per-agent-group image builder: synthesize a Dockerfile layering custom
 * apt + npm packages on top of the base image, then `docker build` (or
 * `container build`) the result.
 *
 * Extracted from src/container-runner.ts so the image-construction
 * logic is testable without a container runtime. Pure-ish: the only side
 * effect is the temp Dockerfile written under data/ and the build
 * invocation, both of which are deterministic.
 */
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { CONTAINER_IMAGE, CONTAINER_IMAGE_BASE, DATA_DIR } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { log } from './log.js';

const execAsync = promisify(exec);

/**
 * Build a per-agent-group image with custom packages.
 *
 * Throws on missing agent group, missing container config, or no
 * packages to install. The build itself runs asynchronously against
 * the configured runtime binary (docker by default; container when
 * CONTAINER_RUNTIME=container).
 */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) throw new Error('Container config not found');
  const aptPackages = JSON.parse(configRow.packages_apt) as string[];
  const npmPackages = JSON.parse(configRow.packages_npm) as string[];
  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    // Awaited async exec so the single-threaded host stays responsive during
    // the build (can take minutes) instead of blocking on execSync. exec buffers
    // stdout/stderr (matching the old stdio: 'pipe') and rejects on a non-zero
    // exit, so error propagation is unchanged.
    await execAsync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      timeout: 900_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in the DB
  updateContainerConfigScalars(agentGroup.id, { image_tag: imageTag });

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}

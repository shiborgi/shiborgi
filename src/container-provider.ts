/**
 * Provider name resolution: precedence rules for determining which
 * provider a session uses, plus the host-side contribution lookup.
 *
 * Extracted from src/container-runner.ts so the pure precedence rule
 * can be unit-tested without a DB. Precedence (top wins):
 *
 *   sessions.agent_provider
 *     → container_configs.provider
 *     → 'claude'
 */
import path from 'path';

import { GROUPS_DIR } from './config.js';
import {
  getProviderContainerConfig,
  type ProviderContainerContribution,
} from './providers/provider-container-registry.js';
import { sessionDir } from './session-manager.js';
import type { AgentGroup, Session } from './types.js';
import type { ContainerConfig } from './container-config.js';

/**
 * Pick the provider name for a session. Pure so the precedence can be
 * unit-tested without a DB or filesystem.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return (sessionProvider || containerConfigProvider || 'claude').toLowerCase();
}

export interface ResolvedProvider {
  provider: string;
  contribution: ProviderContainerContribution;
}

/**
 * Look up the effective provider + its host-side contribution
 * (extra mounts, env passthrough). The contribution is computed once
 * per spawn and threaded through both buildMounts and buildContainerArgs
 * so side effects (mkdir, etc.) fire exactly once.
 */
export function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: ContainerConfig,
  selectedSkills: string[],
): ResolvedProvider {
  const provider = resolveProviderName(session.agent_provider, containerConfig.provider);
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        groupDir: path.resolve(GROUPS_DIR, agentGroup.folder),
        selectedSkills,
        hostEnv: process.env,
      })
    : {};
  return { provider, contribution };
}

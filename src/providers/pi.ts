/**
 * Pi (coding-agent) provider — host-side container config.
 *
 * The container-side provider (`container/agent-runner/src/providers/pi.ts`)
 * spawns `pi --mode rpc` over stdin/stdout and reads provider/model/passthrough
 * env vars from the container env. This host module's only job is to forward
 * the runtime knobs into the container so the in-container pi process can
 * consume them:
 *
 *   - PI_PROVIDER         → pi's --provider flag
 *   - PI_MODEL            → pi's --model flag (provider/id form)
 *   - ANTHROPIC_API_KEY   → forwarded only when set (pi reads it natively for
 *                          the anthropic provider — same env var as the
 *                          Claude SDK, so `use-native-credential-proxy` and
 *                          the pi provider cooperate on the same Anthropic
 *                          credential)
 *   - ANTHROPIC_BASE_URL  → forwarded only when set; pi reads it to route
 *                          Anthropic requests through a custom endpoint
 *
 * Anything pi-specific (OpenAI, OpenRouter, Google, etc.) lives in pi's own
 * auth model — see pi.dev/docs/latest/providers for the env mapping. The
 * `.env` for those providers is read by pi itself inside the container;
 * `readEnvFile` here only forwards what the OpenCode-equivalent knob needs
 * to map nanoclaw's selector onto pi's selector.
 */
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('pi', () => {
  const dotenv = readEnvFile(['PI_PROVIDER', 'PI_MODEL', 'ANTHROPIC_BASE_URL']);
  const env: Record<string, string> = {};

  // Pi resolves provider and model on its own at startup; forwarding both
  // means `ncl groups config update --provider pi && ncl groups restart`
  // is sufficient — no container env changes required.
  if (dotenv.PI_PROVIDER) env.PI_PROVIDER = dotenv.PI_PROVIDER;
  if (dotenv.PI_MODEL) env.PI_MODEL = dotenv.PI_MODEL;

  // The provider-specific credential lives in pi's auth surface
  // (`~/.pi/agent/auth.json` or its provider-specific env). The only
  // exception is `anthropic`, where pi reads the same env vars as the
  // Claude SDK — ANTHROPIC_BASE_URL alone is forwarded.
  if (dotenv.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;

  return { env };
});

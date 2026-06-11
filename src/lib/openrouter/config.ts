import type { Settings } from "@/lib/settings/service";

/**
 * Resolve the OpenRouter API key: the DRYDOCK_OPENROUTER_API_KEY environment
 * variable wins over the key stored in settings, so headless deployments can
 * keep the secret out of the SQLite file entirely (issue #169). Returns an
 * empty string when neither source is configured.
 */
export function resolveOpenRouterApiKey(settings: Settings): string {
  const fromEnv = process.env.DRYDOCK_OPENROUTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  return settings.openrouterApiKey;
}

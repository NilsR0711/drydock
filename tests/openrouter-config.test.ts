import { afterEach, describe, expect, it } from "vitest";
import { resolveOpenRouterApiKey } from "@/lib/openrouter/config";
import { settingsSchema } from "@/lib/settings/service";

const ENV_KEY = "DRYDOCK_OPENROUTER_API_KEY";

function settingsWith(apiKey: string) {
  return settingsSchema.parse({ openrouterApiKey: apiKey });
}

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe("resolveOpenRouterApiKey (issue #169)", () => {
  it("uses the stored settings key by default", () => {
    expect(resolveOpenRouterApiKey(settingsWith("sk-or-v1-stored"))).toBe("sk-or-v1-stored");
  });

  it("prefers the DRYDOCK_OPENROUTER_API_KEY env override", () => {
    process.env[ENV_KEY] = "sk-or-v1-env";
    expect(resolveOpenRouterApiKey(settingsWith("sk-or-v1-stored"))).toBe("sk-or-v1-env");
  });

  it("returns an empty string when neither source is configured", () => {
    expect(resolveOpenRouterApiKey(settingsWith(""))).toBe("");
  });

  it("ignores a whitespace-only env value", () => {
    process.env[ENV_KEY] = "   ";
    expect(resolveOpenRouterApiKey(settingsWith("sk-or-v1-stored"))).toBe("sk-or-v1-stored");
  });
});

import { describe, expect, it } from "vitest";
import { isSandboxEnabled, resolveImage, resolveSandboxConfig } from "@/lib/sandbox/config";

const repoBase = {
  sandbox: "none" as string,
  sandboxImage: null as string | null,
  sandboxAllowNetwork: false,
  sandboxCpus: null as string | null,
  sandboxMemory: null as string | null,
};

describe("resolveSandboxConfig", () => {
  it("reports mode none for a repo that has not opted in", () => {
    const cfg = resolveSandboxConfig(repoBase, { sandboxDefaultImage: "node:20" });
    expect(cfg.mode).toBe("none");
    expect(isSandboxEnabled(cfg)).toBe(false);
  });

  it("reports mode docker and carries the isolation knobs when opted in", () => {
    const cfg = resolveSandboxConfig(
      {
        sandbox: "docker",
        sandboxImage: "  my/image:1  ",
        sandboxAllowNetwork: true,
        sandboxCpus: " 2 ",
        sandboxMemory: " 4g ",
      },
      { sandboxDefaultImage: "node:20" },
    );
    expect(cfg.mode).toBe("docker");
    expect(isSandboxEnabled(cfg)).toBe(true);
    expect(cfg.imageOverride).toBe("my/image:1");
    expect(cfg.allowNetwork).toBe(true);
    expect(cfg.cpus).toBe("2");
    expect(cfg.memory).toBe("4g");
    expect(cfg.defaultImage).toBe("node:20");
  });

  it("normalises blank image/cpu/memory overrides to null", () => {
    const cfg = resolveSandboxConfig(
      {
        sandbox: "docker",
        sandboxImage: "   ",
        sandboxAllowNetwork: false,
        sandboxCpus: "",
        sandboxMemory: "  ",
      },
      { sandboxDefaultImage: "node:20" },
    );
    expect(cfg.imageOverride).toBeNull();
    expect(cfg.cpus).toBeNull();
    expect(cfg.memory).toBeNull();
  });
});

describe("resolveImage precedence", () => {
  const cfg = resolveSandboxConfig(
    {
      sandbox: "docker",
      sandboxImage: null,
      sandboxAllowNetwork: false,
      sandboxCpus: null,
      sandboxMemory: null,
    },
    { sandboxDefaultImage: "node:20-bookworm" },
  );

  it("uses the explicit per-repo image override above everything", () => {
    const withOverride = { ...cfg, imageOverride: "repo/explicit:1" };
    const image = resolveImage(withOverride, "/wt", {
      readFileText: () => '{"image":"devcontainer/img:2"}',
    });
    expect(image).toBe("repo/explicit:1");
  });

  it("falls back to the devcontainer.json image when no override is set", () => {
    const image = resolveImage(cfg, "/wt", {
      readFileText: (p) =>
        p.endsWith("/.devcontainer/devcontainer.json")
          ? '{\n  // a comment\n  "image": "devcontainer/img:2",\n}'
          : null,
    });
    expect(image).toBe("devcontainer/img:2");
  });

  it("reads the top-level .devcontainer.json variant too", () => {
    const image = resolveImage(cfg, "/wt", {
      readFileText: (p) => (p.endsWith("/.devcontainer.json") ? '{"image":"top/level:3"}' : null),
    });
    expect(image).toBe("top/level:3");
  });

  it("falls back to the global default image when no override or devcontainer image exists", () => {
    const image = resolveImage(cfg, "/wt", { readFileText: () => null });
    expect(image).toBe("node:20-bookworm");
  });

  it("ignores a devcontainer that only declares a Dockerfile build (no image)", () => {
    const image = resolveImage(cfg, "/wt", {
      readFileText: (p) =>
        p.endsWith("/.devcontainer/devcontainer.json")
          ? '{"build":{"dockerfile":"Dockerfile"}}'
          : null,
    });
    expect(image).toBe("node:20-bookworm");
  });

  it("returns null when no image can be resolved at all", () => {
    const noDefault = { ...cfg, defaultImage: "" };
    const image = resolveImage(noDefault, "/wt", { readFileText: () => null });
    expect(image).toBeNull();
  });

  it("does not crash on malformed devcontainer JSON, falling through to the default", () => {
    const image = resolveImage(cfg, "/wt", { readFileText: () => "{ not json" });
    expect(image).toBe("node:20-bookworm");
  });
});

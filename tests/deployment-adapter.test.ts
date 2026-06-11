import { describe, expect, it, vi } from "vitest";
import type { CommandResult, CommandRunner } from "@/lib/exec/runner";
import type { DeploymentContext } from "@/lib/orchestrator/deployment/adapter";
import { parseRailwayStatus, RailwayAdapter } from "@/lib/orchestrator/deployment/railway";
import {
  detectDeploymentPlatform,
  getDeploymentAdapter,
  listDeploymentPlatforms,
} from "@/lib/orchestrator/deployment/registry";
import {
  parseVercelDeploymentUrl,
  parseVercelStatus,
  VercelAdapter,
} from "@/lib/orchestrator/deployment/vercel";

function runnerReturning(result: Partial<CommandResult>): CommandRunner {
  return vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0, ...result }));
}

function ctx(overrides: Partial<DeploymentContext> = {}): DeploymentContext {
  return {
    cwd: "/repo",
    run: runnerReturning({}),
    exists: () => false,
    ...overrides,
  };
}

describe("parseVercelStatus", () => {
  it("maps the status token of the first deployment line", () => {
    const out = [
      "Age  Deployment                       Status   Duration",
      "5m   https://app-abc.vercel.app       ● Ready  30s",
    ].join("\n");
    expect(parseVercelStatus(out, 0)).toBe("ready");
  });

  it("returns not_found when the commit-scoped list has no deployment yet", () => {
    // A `vercel list --meta githubCommitSha=…` table with no matching rows.
    expect(parseVercelStatus("Age  Deployment  Status  Duration", 0)).toBe("not_found");
    expect(parseVercelStatus("", 0)).toBe("not_found");
  });

  it("maps error, building, and queued states", () => {
    expect(parseVercelStatus("9m  https://app.vercel.app  ● Error  12s", 0)).toBe("error");
    expect(parseVercelStatus("● Building  https://app.vercel.app", 0)).toBe("building");
    expect(parseVercelStatus("● Queued  https://app.vercel.app", 0)).toBe("deploying");
  });

  it("treats a non-zero exit as not_found", () => {
    expect(parseVercelStatus("Error: not authorized", 1)).toBe("not_found");
  });
});

describe("parseVercelDeploymentUrl", () => {
  it("extracts the deployment URL from a list line", () => {
    expect(parseVercelDeploymentUrl("5m  https://app-abc.vercel.app  ● Ready  30s")).toBe(
      "https://app-abc.vercel.app",
    );
  });

  it("returns null when no URL is present", () => {
    expect(parseVercelDeploymentUrl("Age  Deployment  Status")).toBeNull();
  });
});

describe("parseRailwayStatus", () => {
  it("maps the railway state tokens", () => {
    expect(parseRailwayStatus("Deployment status: SUCCESS", 0)).toBe("ready");
    expect(parseRailwayStatus("Deployment status: FAILED", 0)).toBe("error");
    expect(parseRailwayStatus("status: CRASHED", 0)).toBe("error");
    expect(parseRailwayStatus("status: BUILDING", 0)).toBe("building");
    expect(parseRailwayStatus("status: DEPLOYING", 0)).toBe("deploying");
  });

  it("treats a non-zero exit as not_found", () => {
    expect(parseRailwayStatus("Project not found", 1)).toBe("not_found");
  });
});

describe("VercelAdapter", () => {
  it("detects via vercel.json or .vercel directory", async () => {
    const adapter = new VercelAdapter();
    expect(await adapter.detect(ctx({ exists: (p) => p.endsWith("vercel.json") }))).toBe(true);
    expect(await adapter.detect(ctx({ exists: (p) => p.endsWith(".vercel") }))).toBe(true);
    expect(await adapter.detect(ctx({ exists: () => false }))).toBe(false);
  });

  it("scopes `vercel list` to the watched commit via --meta", async () => {
    const run = runnerReturning({ stdout: "https://app.vercel.app ● Ready", exitCode: 0 });
    const status = await new VercelAdapter().getStatus(ctx({ run, ref: "abc1234", cwd: "/r" }));
    expect(status).toBe("ready");
    expect(run).toHaveBeenCalledWith("vercel", ["list", "--meta", "githubCommitSha=abc1234"], "/r");
  });

  it("runs a plain `vercel list` when no ref is given", async () => {
    const run = runnerReturning({ stdout: "url ● Ready", exitCode: 0 });
    const status = await new VercelAdapter().getStatus(ctx({ run, cwd: "/r" }));
    expect(status).toBe("ready");
    expect(run).toHaveBeenCalledWith("vercel", ["list"], "/r");
  });

  it("inspects logs via the deployment URL resolved from the commit-scoped list", async () => {
    // `vercel inspect` takes a deployment URL/id, never a git SHA: the adapter
    // must resolve the URL from the meta-filtered list first.
    const run = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "list") {
        return {
          stdout: "5m  https://app-abc.vercel.app  ● Error  30s",
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "build failed: TS2304", stderr: "", exitCode: 0 };
    });
    const logs = await new VercelAdapter().getLogs(ctx({ run, ref: "abc1234" }));
    expect(logs).toContain("build failed");
    expect(run).toHaveBeenCalledWith(
      "vercel",
      ["list", "--meta", "githubCommitSha=abc1234"],
      "/repo",
    );
    expect(run).toHaveBeenCalledWith(
      "vercel",
      ["inspect", "--logs", "https://app-abc.vercel.app"],
      "/repo",
    );
  });

  it("falls back to `vercel logs` when no deployment URL resolves", async () => {
    const run = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "list") return { stdout: "Age  Deployment", stderr: "", exitCode: 0 };
      return { stdout: "tail", stderr: "", exitCode: 0 };
    });
    const logs = await new VercelAdapter().getLogs(ctx({ run, ref: "abc1234" }));
    expect(logs).toBe("tail");
    expect(run).toHaveBeenCalledWith("vercel", ["logs"], "/repo");
  });
});

describe("RailwayAdapter", () => {
  it("detects via railway config files", async () => {
    const adapter = new RailwayAdapter();
    expect(await adapter.detect(ctx({ exists: (p) => p.endsWith("railway.toml") }))).toBe(true);
    expect(await adapter.detect(ctx({ exists: () => false }))).toBe(false);
  });

  it("runs `railway status` for status", async () => {
    const run = runnerReturning({ stdout: "status: FAILED", exitCode: 0 });
    const status = await new RailwayAdapter().getStatus(ctx({ run }));
    expect(status).toBe("error");
    expect(run).toHaveBeenCalledWith("railway", ["status"], "/repo");
  });
});

describe("deployment registry", () => {
  it("constructs an adapter by id and lists platforms", () => {
    expect(getDeploymentAdapter("vercel").id).toBe("vercel");
    expect(getDeploymentAdapter("railway").id).toBe("railway");
    expect(() => getDeploymentAdapter("netlify" as never)).toThrow(/unsupported/);
    expect(listDeploymentPlatforms().map((p) => p.id)).toEqual(["vercel", "railway"]);
  });

  it("honours an explicit override without detecting", async () => {
    const detectSpy = vi.fn(async () => true);
    const adapter = await detectDeploymentPlatform(ctx({ exists: detectSpy as never }), "railway");
    expect(adapter?.id).toBe("railway");
  });

  it("returns null for an invalid override", async () => {
    expect(await detectDeploymentPlatform(ctx(), "heroku")).toBeNull();
  });

  it("detects the first matching platform when no override is set", async () => {
    const vercel = await detectDeploymentPlatform(
      ctx({ exists: (p) => p.endsWith("vercel.json") }),
    );
    expect(vercel?.id).toBe("vercel");
    const railway = await detectDeploymentPlatform(
      ctx({ exists: (p) => p.endsWith("railway.json") }),
    );
    expect(railway?.id).toBe("railway");
  });

  it("returns null when no platform is detected", async () => {
    expect(await detectDeploymentPlatform(ctx({ exists: () => false }))).toBeNull();
  });
});

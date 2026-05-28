import { describe, expect, it, vi } from "vitest";
import type { CommandResult, CommandRunner } from "@/lib/exec/runner";
import type { DeploymentContext } from "@/lib/orchestrator/deployment/adapter";
import { parseRailwayStatus, RailwayAdapter } from "@/lib/orchestrator/deployment/railway";
import {
  detectDeploymentPlatform,
  getDeploymentAdapter,
  listDeploymentPlatforms,
} from "@/lib/orchestrator/deployment/registry";
import { parseVercelStatus, VercelAdapter } from "@/lib/orchestrator/deployment/vercel";

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
  it("maps the status tokens for the matching ref line", () => {
    const out = [
      "Age  Deployment                       Status   Duration  Commit",
      "5m   https://app-abc.vercel.app       ● Ready  30s       deadbee feat: x",
      "9m   https://app-old.vercel.app       ● Error  12s       0000000 old",
    ].join("\n");
    expect(parseVercelStatus(out, 0, "deadbeef1234")).toBe("ready");
    expect(parseVercelStatus(out, 0, "0000000aaaa")).toBe("error");
  });

  it("returns not_found when the ref has no deployment line yet", () => {
    expect(parseVercelStatus("● Ready  somethingelse", 0, "deadbeef")).toBe("not_found");
  });

  it("maps building and queued states", () => {
    expect(parseVercelStatus("● Building  abc1234", 0, "abc1234")).toBe("building");
    expect(parseVercelStatus("● Queued  abc1234", 0, "abc1234")).toBe("deploying");
  });

  it("treats a non-zero exit as not_found", () => {
    expect(parseVercelStatus("Error: not authorized", 1, "abc")).toBe("not_found");
  });

  it("reads the latest deployment when no ref is given", () => {
    expect(parseVercelStatus("5m  url  ● Ready  30s", 0)).toBe("ready");
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

  it("runs `vercel list` in the repo checkout for status", async () => {
    const run = runnerReturning({ stdout: "url ● Ready abc1234", exitCode: 0 });
    const status = await new VercelAdapter().getStatus(ctx({ run, ref: "abc1234", cwd: "/r" }));
    expect(status).toBe("ready");
    expect(run).toHaveBeenCalledWith("vercel", ["list"], "/r");
  });

  it("inspects logs for a ref", async () => {
    const run = runnerReturning({ stdout: "build failed: TS2304", exitCode: 0 });
    const logs = await new VercelAdapter().getLogs(ctx({ run, ref: "abc1234" }));
    expect(logs).toContain("build failed");
    expect(run).toHaveBeenCalledWith("vercel", ["inspect", "--logs", "abc1234"], "/repo");
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

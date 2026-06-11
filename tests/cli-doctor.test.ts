import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctorCommand } from "../bin/ops.mjs";

type RunnerResult = { exitCode: number; stdout: string; stderr: string };

/** Fake CLI runner: per-command results, missing commands throw like ENOENT. */
function fakeRunner(byCommand: Record<string, RunnerResult>) {
  return async (cmd: string): Promise<RunnerResult> => {
    const result = byCommand[cmd];
    if (!result) throw new Error(`spawn ${cmd} ENOENT`);
    return result;
  };
}

const OK_RUN: RunnerResult = { exitCode: 0, stdout: "1.0.0", stderr: "" };

/** Minimal repos table holding only the columns the doctor reads. */
function createReposDb(
  path: string,
  rows: { agent: string; platform: string; apiBaseUrl?: string; apiToken?: string }[],
): void {
  const db = new Database(path);
  db.exec(
    "CREATE TABLE repos (agent TEXT NOT NULL, platform TEXT NOT NULL, api_base_url TEXT, api_token TEXT)",
  );
  const insert = db.prepare(
    "INSERT INTO repos (agent, platform, api_base_url, api_token) VALUES (?, ?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(row.agent, row.platform, row.apiBaseUrl ?? null, row.apiToken ?? null);
  }
  db.close();
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    log: (line: string) => out.push(line),
    error: (line: string) => err.push(line),
  };
}

const PLENTY_OF_DISK = () => ({ bavail: 1_000_000, bsize: 4096 }); // ~3.8 GiB

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drydock-doctor-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Doctor deps for a healthy setup; tests override pieces and repo rows. */
function healthyDeps(
  io: ReturnType<typeof captureIo>,
  repoRows: Parameters<typeof createReposDb>[1] = [{ agent: "claude", platform: "github" }],
) {
  const dbPath = join(dir, "drydock.db");
  createReposDb(dbPath, repoRows);
  return {
    dbPath,
    dataDir: dir,
    lockPath: join(dir, "instance.lock"),
    runner: fakeRunner({ gh: OK_RUN, claude: OK_RUN, codex: OK_RUN }),
    fetchImpl: (() => {
      throw new Error("unexpected fetch");
    }) as unknown as typeof fetch,
    statfsImpl: PLENTY_OF_DISK,
    ...io,
  };
}

describe("runDoctorCommand", () => {
  it("prints one line per probe and exits 0 when everything is healthy", async () => {
    const io = captureIo();
    const code = await runDoctorCommand(healthyDeps(io));

    expect(code).toBe(0);
    // gh auth, claude, codex, gitlab, disk, db integrity, lock = 7 probes.
    expect(io.out).toHaveLength(7);
    expect(io.out.join("\n")).toMatch(/^ok\s+github auth/m);
    expect(io.out.join("\n")).toMatch(/^ok\s+claude cli/m);
    expect(io.out.join("\n")).not.toMatch(/^fail/m);
  });

  it("fails when `gh auth status` exits non-zero", async () => {
    const io = captureIo();
    const deps = healthyDeps(io);
    deps.runner = fakeRunner({
      gh: { exitCode: 1, stdout: "", stderr: "You are not logged in" },
      claude: OK_RUN,
      codex: OK_RUN,
    });

    const code = await runDoctorCommand(deps);

    expect(code).toBe(1);
    expect(io.out.join("\n")).toMatch(/^fail\s+github auth/m);
    expect(io.out.join("\n")).toContain("not logged in");
  });

  it("fails when the claude CLI is missing", async () => {
    const io = captureIo();
    const deps = healthyDeps(io);
    deps.runner = fakeRunner({ gh: OK_RUN, codex: OK_RUN });

    const code = await runDoctorCommand(deps);

    expect(code).toBe(1);
    expect(io.out.join("\n")).toMatch(/^fail\s+claude cli/m);
  });

  it("skips a missing codex CLI when no repo uses codex", async () => {
    const io = captureIo();
    const deps = healthyDeps(io);
    deps.runner = fakeRunner({ gh: OK_RUN, claude: OK_RUN });

    const code = await runDoctorCommand(deps);

    expect(code).toBe(0);
    expect(io.out.join("\n")).toMatch(/^skip\s+codex cli/m);
  });

  it("fails on a missing codex CLI when a repo is configured to use it", async () => {
    const io = captureIo();
    const deps = healthyDeps(io, [{ agent: "codex", platform: "github" }]);
    deps.runner = fakeRunner({ gh: OK_RUN, claude: OK_RUN });

    const code = await runDoctorCommand(deps);

    expect(code).toBe(1);
    expect(io.out.join("\n")).toMatch(/^fail\s+codex cli/m);
  });

  it("fails when GitLab rejects the configured token", async () => {
    const io = captureIo();
    const deps = healthyDeps(io, [
      {
        agent: "claude",
        platform: "gitlab",
        apiBaseUrl: "https://gitlab.example.com",
        apiToken: "glpat-dead",
      },
    ]);
    let requested = "";
    let sentToken = "";
    deps.fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
      requested = url;
      sentToken = init.headers["PRIVATE-TOKEN"] ?? "";
      return { ok: false, status: 401 };
    }) as unknown as typeof fetch;

    const code = await runDoctorCommand(deps);

    expect(code).toBe(1);
    expect(requested).toBe("https://gitlab.example.com/api/v4/user");
    expect(sentToken).toBe("glpat-dead");
    expect(io.out.join("\n")).toMatch(/^fail\s+gitlab/m);
    expect(io.out.join("\n")).toContain("401");
    // The token itself must never appear in the report.
    expect(io.out.join("\n")).not.toContain("glpat-dead");
  });

  it("reports a healthy GitLab token as ok", async () => {
    const io = captureIo();
    const deps = healthyDeps(io, [
      {
        agent: "claude",
        platform: "gitlab",
        apiBaseUrl: "https://gitlab.example.com",
        apiToken: "glpat-live",
      },
    ]);
    deps.fetchImpl = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;

    const code = await runDoctorCommand(deps);

    expect(code).toBe(0);
    expect(io.out.join("\n")).toMatch(/^ok\s+gitlab/m);
  });

  it("warns (without failing) when the GitLab probe hits a network error", async () => {
    const io = captureIo();
    const deps = healthyDeps(io, [
      {
        agent: "claude",
        platform: "gitlab",
        apiBaseUrl: "https://gitlab.example.com",
        apiToken: "glpat-live",
      },
    ]);
    deps.fetchImpl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND gitlab.example.com");
    }) as unknown as typeof fetch;

    const code = await runDoctorCommand(deps);

    expect(code).toBe(0);
    expect(io.out.join("\n")).toMatch(/^warn\s+gitlab/m);
  });

  it("fails when free disk space at the data dir is critically low", async () => {
    const io = captureIo();
    const deps = healthyDeps(io);
    deps.statfsImpl = () => ({ bavail: 10, bsize: 4096 }); // ~40 KiB

    const code = await runDoctorCommand(deps);

    expect(code).toBe(1);
    expect(io.out.join("\n")).toMatch(/^fail\s+disk space/m);
  });

  it("skips the integrity check when no database exists yet", async () => {
    const io = captureIo();
    const deps = healthyDeps(io);
    deps.dbPath = join(dir, "missing.db");

    const code = await runDoctorCommand(deps);

    expect(code).toBe(0);
    expect(io.out.join("\n")).toMatch(/^skip\s+db integrity/m);
  });

  it("fails the integrity check on a corrupt database file", async () => {
    const io = captureIo();
    const deps = healthyDeps(io);
    deps.dbPath = join(dir, "corrupt.db");
    writeFileSync(deps.dbPath, "definitely not sqlite");

    const code = await runDoctorCommand(deps);

    expect(code).toBe(1);
    expect(io.out.join("\n")).toMatch(/^fail\s+db integrity/m);
  });

  it("reports a live instance holding the lock without failing", async () => {
    const io = captureIo();
    const deps = healthyDeps(io);
    writeFileSync(deps.lockPath, JSON.stringify({ pid: 4242, ts: 1 }));

    const code = await runDoctorCommand({ ...deps, pidAlive: () => true });

    expect(code).toBe(0);
    expect(io.out.join("\n")).toMatch(/^ok\s+instance lock\s+.*4242/m);
  });

  it("warns about a stale lock left by a dead process", async () => {
    const io = captureIo();
    const deps = healthyDeps(io);
    writeFileSync(deps.lockPath, JSON.stringify({ pid: 4242, ts: 1 }));

    const code = await runDoctorCommand({ ...deps, pidAlive: () => false });

    expect(code).toBe(0);
    expect(io.out.join("\n")).toMatch(/^warn\s+instance lock/m);
  });
});

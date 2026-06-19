process.env.DRYDOCK_DB = ":memory:";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/control/pause/route";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { getSettings } from "@/lib/settings/service";

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:3737/api/control/pause", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const GUARD = { "x-drydock-control": "1" };

beforeEach(() => {
  process.env.DRYDOCK_HOME = mkdtempSync(join(tmpdir(), "ac-control-pause-"));
  delete process.env.DRYDOCK_CONTROL_TOKEN;
  getDb().delete(settings).run();
});

afterEach(() => {
  delete process.env.DRYDOCK_HOME;
  delete process.env.DRYDOCK_CONTROL_TOKEN;
});

describe("POST /api/control/pause", () => {
  it("rejects (403) a request without the guard header", async () => {
    const res = await POST(req({ paused: true }));
    expect(res.status).toBe(403);
    expect(getSettings().paused).toBe(false);
  });

  it("pauses automation and echoes the new state", async () => {
    const res = await POST(req({ paused: true }, GUARD));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.json();
    expect(body).toEqual({ ok: true, paused: true });
    expect(getSettings().paused).toBe(true);
  });

  it("resumes automation when paused is false", async () => {
    await POST(req({ paused: true }, GUARD));
    const res = await POST(req({ paused: false }, GUARD));
    const body = await res.json();
    expect(body).toEqual({ ok: true, paused: false });
    expect(getSettings().paused).toBe(false);
  });

  it("rejects (400) a body without a boolean paused field", async () => {
    const res = await POST(req({ paused: "yes" }, GUARD));
    expect(res.status).toBe(400);
    expect(getSettings().paused).toBe(false);
  });

  it("rejects (400) a malformed JSON body", async () => {
    const res = await POST(
      new Request("http://127.0.0.1:3737/api/control/pause", {
        method: "POST",
        headers: { "content-type": "application/json", ...GUARD },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("requires a matching token when DRYDOCK_CONTROL_TOKEN is set", async () => {
    process.env.DRYDOCK_CONTROL_TOKEN = "secret";
    const denied = await POST(req({ paused: true }, GUARD));
    expect(denied.status).toBe(403);
    expect(getSettings().paused).toBe(false);

    const ok = await POST(req({ paused: true }, { ...GUARD, "x-drydock-control-token": "secret" }));
    expect(ok.status).toBe(200);
    expect(getSettings().paused).toBe(true);
  });

  it("matches a token despite surrounding whitespace on env and header", async () => {
    // A trailing newline (e.g. from `$(cat tokenfile)`) on either side must not
    // cause a spurious 403 — both are trimmed before the constant-time compare.
    process.env.DRYDOCK_CONTROL_TOKEN = "secret\n";
    const res = await POST(
      req({ paused: true }, { ...GUARD, "x-drydock-control-token": "  secret " }),
    );
    expect(res.status).toBe(200);
    expect(getSettings().paused).toBe(true);
  });
});

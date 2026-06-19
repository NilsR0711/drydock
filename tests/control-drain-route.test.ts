process.env.DRYDOCK_DB = ":memory:";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/control/drain/route";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { getSettings } from "@/lib/settings/service";

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:3737/api/control/drain", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const GUARD = { "x-drydock-control": "1" };

beforeEach(() => {
  process.env.DRYDOCK_HOME = mkdtempSync(join(tmpdir(), "ac-control-drain-"));
  delete process.env.DRYDOCK_CONTROL_TOKEN;
  getDb().delete(settings).run();
});

afterEach(() => {
  delete process.env.DRYDOCK_HOME;
  delete process.env.DRYDOCK_CONTROL_TOKEN;
});

describe("POST /api/control/drain", () => {
  it("rejects (403) a request without the guard header", async () => {
    const res = await POST(req({ draining: true }));
    expect(res.status).toBe(403);
    expect(getSettings().draining).toBe(false);
  });

  it("enables drain mode and echoes the new state", async () => {
    const res = await POST(req({ draining: true }, GUARD));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.json();
    expect(body).toEqual({ ok: true, draining: true });
    expect(getSettings().draining).toBe(true);
  });

  it("disables drain mode when draining is false", async () => {
    await POST(req({ draining: true }, GUARD));
    const res = await POST(req({ draining: false }, GUARD));
    const body = await res.json();
    expect(body).toEqual({ ok: true, draining: false });
    expect(getSettings().draining).toBe(false);
  });

  it("rejects (400) a body without a boolean draining field", async () => {
    const res = await POST(req({ draining: 1 }, GUARD));
    expect(res.status).toBe(400);
    expect(getSettings().draining).toBe(false);
  });

  it("leaves the pause flag untouched", async () => {
    await POST(req({ draining: true }, GUARD));
    expect(getSettings().paused).toBe(false);
  });
});

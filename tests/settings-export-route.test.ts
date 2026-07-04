process.env.DRYDOCK_DB = ":memory:";

import { beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/settings/export/route";
import { getDb } from "@/lib/db/client";
import { promptTemplates, repos, settings } from "@/lib/db/schema";
import { addRepo } from "@/lib/repos/service";
import { saveSettings } from "@/lib/settings/service";

function get(): Promise<Response> {
  const req = new Request("http://127.0.0.1/api/settings/export");
  return GET(req as never);
}

describe("GET /api/settings/export", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(promptTemplates).run();
    db.delete(repos).run();
    db.delete(settings).run();
  });

  it("serves a JSON attachment with a config filename", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain("drydock-config");
    expect(disposition).toContain(".json");
  });

  it("emits the global settings and per-repo profiles", async () => {
    saveSettings({ maxParallelJobs: 4 });
    addRepo({ path: "/a", name: "owner/a", planFirst: true });
    const res = await get();
    const bundle = JSON.parse(await res.text());
    expect(bundle.drydockConfigVersion).toBe(1);
    expect(bundle.settings.maxParallelJobs).toBe(4);
    expect(bundle.repos).toHaveLength(1);
    expect(bundle.repos[0].name).toBe("owner/a");
  });

  it("redacts secret settings from the download", async () => {
    saveSettings({ smtpPass: "hunter2", openrouterApiKey: "sk-or-v1-secret" });
    const res = await get();
    const body = await res.text();
    expect(body).not.toContain("hunter2");
    expect(body).not.toContain("sk-or-v1-secret");
  });
});

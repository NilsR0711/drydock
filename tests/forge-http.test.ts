import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchHttp } from "@/lib/forge/http";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchHttp", () => {
  it("does not follow redirects, so a bearer/private token is never replayed", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200, headers: { "x-next-page": "2" } }));
    await fetchHttp("https://gitlab.com/api/v4/projects", {
      method: "GET",
      headers: { "PRIVATE-TOKEN": "glpat-secret" },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.redirect).toBe("manual");
  });

  it("returns status, body and lower-cased headers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("body-text", { status: 201, headers: { "X-Next-Page": "3" } }),
    );
    const res = await fetchHttp("https://gitlab.com/api/v4/projects");
    expect(res.status).toBe(201);
    expect(res.ok).toBe(true);
    expect(res.body).toBe("body-text");
    expect(res.headers?.["x-next-page"]).toBe("3");
  });
});

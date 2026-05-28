import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMigrationsDir } from "@/lib/db/client";

describe("resolveMigrationsDir", () => {
  const original = process.env.DRYDOCK_MIGRATIONS;

  afterEach(() => {
    if (original === undefined) delete process.env.DRYDOCK_MIGRATIONS;
    else process.env.DRYDOCK_MIGRATIONS = original;
  });

  it("defaults to the `drizzle` folder under the current working directory", () => {
    delete process.env.DRYDOCK_MIGRATIONS;
    expect(resolveMigrationsDir()).toBe(resolve(process.cwd(), "drizzle"));
  });

  it("honours the DRYDOCK_MIGRATIONS override so a packaged install can ship migrations outside the cwd", () => {
    process.env.DRYDOCK_MIGRATIONS = "/opt/drydock/drizzle";
    expect(resolveMigrationsDir()).toBe("/opt/drydock/drizzle");
  });
});

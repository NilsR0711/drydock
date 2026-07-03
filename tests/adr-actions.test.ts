process.env.DRYDOCK_DB = ":memory:";

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approveAdrAction, rejectAdrAction } from "@/lib/adr/actions";
import { registerAdr } from "@/lib/adr/service";
import { getDb } from "@/lib/db/client";
import { adrs } from "@/lib/db/schema";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Intentionally a literal copy of the separator in `src/lib/adr/actions.ts`,
// NOT an import of the constant: the stored title is a data contract, so a
// silent separator change (issue #387) must fail these assertions.
const SUFFIX = " — rejected: ";

/** Register a fresh pending ADR whose title is `title`; returns its id. */
let seq = 0;
function newAdr(title: string): number {
  seq += 1;
  return registerAdr({ filePath: `/r/docs/adr/${seq}.md`, content: `# ${title}` }).id;
}

function getAdr(id: number) {
  const row = getDb().select().from(adrs).where(eq(adrs.id, id)).get();
  if (!row) throw new Error(`test setup: adr ${id} missing`);
  return row;
}

beforeEach(() => {
  getDb().delete(adrs).run();
});

describe("approveAdrAction", () => {
  it("strips a stale rejection suffix from the title", async () => {
    const id = newAdr("Use Foo");
    await rejectAdrAction(id, "not now");
    expect(getAdr(id).title).toBe(`Use Foo${SUFFIX}not now`);

    await approveAdrAction(id);

    const row = getAdr(id);
    expect(row.status).toBe("approved");
    expect(row.title).toBe("Use Foo");
  });

  it("leaves a clean title untouched", async () => {
    const id = newAdr("Use Bar");
    await approveAdrAction(id);

    const row = getAdr(id);
    expect(row.status).toBe("approved");
    expect(row.title).toBe("Use Bar");
  });
});

describe("rejectAdrAction", () => {
  it("is idempotent on a double submit (does not re-append the suffix)", async () => {
    const id = newAdr("Use Foo");
    await rejectAdrAction(id, "first reason");
    const afterFirst = getAdr(id).title;
    expect(afterFirst).toBe(`Use Foo${SUFFIX}first reason`);

    // Second submit (double click / stale tab) — the row is already rejected.
    await rejectAdrAction(id, "second reason");

    const row = getAdr(id);
    expect(row.status).toBe("rejected");
    expect(row.title).toBe(afterFirst);
  });

  it("strips a prior suffix before appending so suffixes never accumulate", async () => {
    // A non-rejected row that already carries a suffix in its title (e.g. left
    // over from earlier handling) must be normalised on reject, not stacked.
    const id = newAdr(`Use Foo${SUFFIX}stale`);
    await rejectAdrAction(id, "fresh");

    const { title } = getAdr(id);
    expect(title).toBe(`Use Foo${SUFFIX}fresh`);
    expect(title.split(SUFFIX)).toHaveLength(2);
    expect(title.slice(0, title.indexOf(SUFFIX))).toBe("Use Foo");
  });

  it("keeps the base title recoverable across a reject → approve → reject cycle", async () => {
    const id = newAdr("Use Foo");
    await rejectAdrAction(id, "bad");
    await approveAdrAction(id);
    await rejectAdrAction(id, "worse");

    const { title } = getAdr(id);
    expect(title).toBe(`Use Foo${SUFFIX}worse`);
    expect(title.split(SUFFIX)).toHaveLength(2);
    expect(title.slice(0, title.indexOf(SUFFIX))).toBe("Use Foo");
  });

  it("trims the rejection comment", async () => {
    const id = newAdr("Use Foo");
    await rejectAdrAction(id, "  spaced reason  ");
    expect(getAdr(id).title).toBe(`Use Foo${SUFFIX}spaced reason`);
  });

  it("truncates the rejection comment to 200 characters", async () => {
    const id = newAdr("Use Foo");
    await rejectAdrAction(id, "x".repeat(300));

    const { title } = getAdr(id);
    const reason = title.slice(title.indexOf(SUFFIX) + SUFFIX.length);
    expect(reason).toBe("x".repeat(200));
    expect(title).toBe(`Use Foo${SUFFIX}${"x".repeat(200)}`);
  });

  it("leaves the title unchanged for an empty/whitespace comment", async () => {
    const id = newAdr("Use Foo");
    await rejectAdrAction(id, "   ");

    const row = getAdr(id);
    expect(row.status).toBe("rejected");
    expect(row.title).toBe("Use Foo");
  });

  it("throws for an unknown ADR id", async () => {
    await expect(rejectAdrAction(999_999, "whatever")).rejects.toThrow(/not found/);
  });
});

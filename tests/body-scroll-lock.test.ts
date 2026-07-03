// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { lockBodyScroll } from "@/lib/ui/body-scroll-lock";

describe("lockBodyScroll", () => {
  afterEach(() => {
    // Reset any style/attribute residue between tests.
    document.body.style.overflow = "";
    document.body.removeAttribute("style");
  });

  test("locks body scroll on first acquire", () => {
    const release = lockBodyScroll();
    expect(document.body.style.overflow).toBe("hidden");
    release();
  });

  test("restores the previous overflow value on release", () => {
    document.body.style.overflow = "scroll";
    const release = lockBodyScroll();
    expect(document.body.style.overflow).toBe("hidden");
    release();
    expect(document.body.style.overflow).toBe("scroll");
  });

  test("restores an empty overflow when none was set", () => {
    expect(document.body.style.overflow).toBe("");
    const release = lockBodyScroll();
    expect(document.body.style.overflow).toBe("hidden");
    release();
    expect(document.body.style.overflow).toBe("");
  });

  test("stacked locks keep the body locked until the last release", () => {
    const releaseA = lockBodyScroll();
    const releaseB = lockBodyScroll();
    expect(document.body.style.overflow).toBe("hidden");

    // First-closed dialog must not unlock scroll prematurely.
    releaseA();
    expect(document.body.style.overflow).toBe("hidden");

    releaseB();
    expect(document.body.style.overflow).toBe("");
  });

  test("captures the pre-lock overflow only from the outermost lock", () => {
    document.body.style.overflow = "auto";
    const releaseA = lockBodyScroll();
    const releaseB = lockBodyScroll();
    releaseB();
    releaseA();
    // The original value present before *any* lock is what gets restored.
    expect(document.body.style.overflow).toBe("auto");
  });

  test("release is idempotent and does not corrupt the counter", () => {
    const releaseA = lockBodyScroll();
    const releaseB = lockBodyScroll();
    releaseA();
    releaseA(); // double release must be a no-op
    // B is still holding the lock.
    expect(document.body.style.overflow).toBe("hidden");
    releaseB();
    expect(document.body.style.overflow).toBe("");
  });
});

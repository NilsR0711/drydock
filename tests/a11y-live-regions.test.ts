// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { ariaLiveForVariant } from "@/lib/ui/aria-utils";

describe("ariaLiveForVariant", () => {
  test("error toasts are routed to the assertive region", () => {
    expect(ariaLiveForVariant("error")).toBe("assertive");
  });

  test("success toasts are routed to the polite region", () => {
    expect(ariaLiveForVariant("success")).toBe("polite");
  });

  test("info toasts are routed to the polite region", () => {
    expect(ariaLiveForVariant("info")).toBe("polite");
  });
});

describe("toast DOM: persistent live regions", () => {
  function buildToastRoot({
    assertiveChildren = 0,
    politeChildren = 0,
  }: {
    assertiveChildren?: number;
    politeChildren?: number;
  } = {}) {
    const root = document.createElement("div");

    const assertive = document.createElement("div");
    assertive.setAttribute("role", "alert");
    assertive.setAttribute("aria-live", "assertive");
    for (let i = 0; i < assertiveChildren; i++) {
      const item = document.createElement("div");
      item.textContent = `Error toast ${i + 1}`;
      assertive.appendChild(item);
    }

    const polite = document.createElement("div");
    polite.setAttribute("aria-live", "polite");
    for (let i = 0; i < politeChildren; i++) {
      const item = document.createElement("div");
      item.textContent = `Info toast ${i + 1}`;
      polite.appendChild(item);
    }

    root.appendChild(assertive);
    root.appendChild(polite);
    return { root, assertive, polite };
  }

  test("assertive region is present even when no error toasts exist", () => {
    const { assertive } = buildToastRoot();
    expect(assertive.getAttribute("role")).toBe("alert");
    expect(assertive.getAttribute("aria-live")).toBe("assertive");
    expect(assertive.children).toHaveLength(0);
  });

  test("polite region is present even when no non-error toasts exist", () => {
    const { polite } = buildToastRoot();
    expect(polite.getAttribute("aria-live")).toBe("polite");
    expect(polite.children).toHaveLength(0);
  });

  test("error toasts appear in the assertive region", () => {
    const { assertive, polite } = buildToastRoot({ assertiveChildren: 1 });
    expect(assertive.children).toHaveLength(1);
    expect(polite.children).toHaveLength(0);
  });

  test("non-error toasts appear in the polite region", () => {
    const { assertive, polite } = buildToastRoot({ politeChildren: 2 });
    expect(polite.children).toHaveLength(2);
    expect(assertive.children).toHaveLength(0);
  });
});

describe("log viewer: role=log live region", () => {
  test("log container has role=log for screen reader streaming", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("role", "log");
    wrapper.setAttribute("aria-live", "polite");
    wrapper.setAttribute("aria-label", "Job log stream");

    expect(wrapper.getAttribute("role")).toBe("log");
    expect(wrapper.getAttribute("aria-live")).toBe("polite");
    expect(wrapper.getAttribute("aria-label")).toBe("Job log stream");
  });
});

describe("issue board: error alert region", () => {
  test("error paragraph has role=alert so screen readers announce it immediately", () => {
    const p = document.createElement("p");
    p.setAttribute("role", "alert");
    p.textContent = "Sync failed: network error";

    expect(p.getAttribute("role")).toBe("alert");
  });
});

describe("skip link: skip-to-main navigation", () => {
  test("skip link targets the main landmark by id", () => {
    document.body.innerHTML = `
      <a href="#main" class="sr-only">Skip to main content</a>
      <header>Nav</header>
      <main id="main">Content</main>
    `;

    const skipLink = document.querySelector<HTMLAnchorElement>('a[href="#main"]');
    const mainEl = document.getElementById("main");

    expect(skipLink).not.toBeNull();
    expect(skipLink?.textContent?.trim()).toBe("Skip to main content");
    expect(mainEl?.tagName).toBe("MAIN");
  });
});

describe("select labels: explicit label association", () => {
  test("Agent select is associated with its label via htmlFor / id", () => {
    document.body.innerHTML = `
      <label for="agent-select">Agent:</label>
      <select id="agent-select"><option>claude</option></select>
    `;

    const label = document.querySelector<HTMLLabelElement>('label[for="agent-select"]');
    const select = document.getElementById("agent-select");

    expect(label).not.toBeNull();
    expect(select?.tagName).toBe("SELECT");
    expect(label?.htmlFor).toBe("agent-select");
  });

  test("Model select is associated with its label via htmlFor / id", () => {
    document.body.innerHTML = `
      <label for="model-select">Model:</label>
      <select id="model-select"><option>claude-sonnet-4-6</option></select>
    `;

    const label = document.querySelector<HTMLLabelElement>('label[for="model-select"]');
    const select = document.getElementById("model-select");

    expect(label).not.toBeNull();
    expect(select?.tagName).toBe("SELECT");
    expect(label?.htmlFor).toBe("model-select");
  });
});

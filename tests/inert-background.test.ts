// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { hideBackground } from "@/lib/ui/inert-background";

/**
 * Builds a DOM tree that mirrors how a Dialog mounts inline inside the app:
 *
 *   body
 *     ├── sibA          (background — must be hidden)
 *     ├── shell         (contains the dialog)
 *     │     ├── content (background sibling of the dialog — must be hidden)
 *     │     └── root    (the dialog's fixed overlay wrapper — target)
 *     │           └── panel[role=dialog]
 *     └── sibB          (background — must be hidden)
 */
function buildTree() {
  const sibA = document.createElement("div");
  sibA.id = "sibA";
  const shell = document.createElement("div");
  shell.id = "shell";
  const content = document.createElement("div");
  content.id = "content";
  const root = document.createElement("div");
  root.id = "root";
  const panel = document.createElement("div");
  panel.setAttribute("role", "dialog");
  const sibB = document.createElement("div");
  sibB.id = "sibB";

  root.appendChild(panel);
  shell.appendChild(content);
  shell.appendChild(root);
  document.body.append(sibA, shell, sibB);
  return { sibA, shell, content, root, panel, sibB };
}

function isHidden(el: Element): boolean {
  return el.getAttribute("aria-hidden") === "true" && el.hasAttribute("inert");
}

describe("hideBackground", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("hides every background sibling on the path from the target up to the body", () => {
    const { sibA, content, root, sibB } = buildTree();
    hideBackground(root);
    expect(isHidden(sibA)).toBe(true);
    expect(isHidden(sibB)).toBe(true);
    expect(isHidden(content)).toBe(true);
  });

  test("leaves the target, its ancestors and its subtree interactive", () => {
    const { shell, root, panel } = buildTree();
    hideBackground(root);
    // Ancestor on the path stays reachable.
    expect(shell.hasAttribute("inert")).toBe(false);
    expect(shell.getAttribute("aria-hidden")).toBeNull();
    // Target itself is never hidden.
    expect(root.hasAttribute("inert")).toBe(false);
    // Nothing inside the target (backdrop/panel) is touched — the backdrop must
    // keep receiving the click-outside-to-close pointer events.
    expect(panel.hasAttribute("inert")).toBe(false);
    expect(panel.getAttribute("aria-hidden")).toBeNull();
  });

  test("restore() reverts the background to its original state", () => {
    const { sibA, content, sibB } = buildTree();
    const restore = hideBackground(document.getElementById("root") as HTMLElement);
    restore();
    for (const el of [sibA, content, sibB]) {
      expect(el.hasAttribute("inert")).toBe(false);
      expect(el.getAttribute("aria-hidden")).toBeNull();
    }
  });

  test("preserves a pre-existing aria-hidden value instead of clobbering it", () => {
    const { sibA, root } = buildTree();
    sibA.setAttribute("aria-hidden", "true"); // e.g. a decorative element
    const restore = hideBackground(root);
    expect(sibA.getAttribute("aria-hidden")).toBe("true");
    restore();
    // The attribute the app set must survive; the dialog only owns what it added.
    expect(sibA.getAttribute("aria-hidden")).toBe("true");
  });

  test("stacked dialogs keep a shared background element hidden until the last restore", () => {
    const { sibA, root } = buildTree();
    // A second dialog opens on top, targeting a different subtree but sharing
    // sibA as a background element.
    const secondRoot = document.createElement("div");
    document.body.appendChild(secondRoot);

    const restoreFirst = hideBackground(root);
    const restoreSecond = hideBackground(secondRoot);
    expect(isHidden(sibA)).toBe(true);

    restoreFirst();
    // The second dialog still needs sibA hidden.
    expect(isHidden(sibA)).toBe(true);

    restoreSecond();
    expect(sibA.hasAttribute("inert")).toBe(false);
    expect(sibA.getAttribute("aria-hidden")).toBeNull();
  });

  test("restore is idempotent", () => {
    const { sibA, root } = buildTree();
    const restore = hideBackground(root);
    restore();
    restore(); // must not throw or re-hide
    expect(sibA.hasAttribute("inert")).toBe(false);
  });
});

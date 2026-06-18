import { describe, expect, it } from "vitest";
import { installAudioUnlock, playChime } from "@/lib/ui/chime";

// Web Audio is a browser-only API; in the node test environment neither
// `window` nor `AudioContext` exists. The chime must degrade silently rather
// than throw so importing it on the server (RSC) or an unsupported browser is
// safe.
describe("chime (issue #258)", () => {
  it("no-ops without a browser audio context", () => {
    expect(() => playChime()).not.toThrow();
  });

  it("no-ops installing the autoplay unlock without a window", () => {
    expect(() => installAudioUnlock()).not.toThrow();
  });
});

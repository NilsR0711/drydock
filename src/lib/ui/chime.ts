"use client";

// A short, synthesized two-note chime announcing a job that needs a human
// (issue #258). Built on the Web Audio API so we ship no binary asset, and
// gated by the browser autoplay policy: the AudioContext starts suspended and
// is only resumed after the first user gesture (see installAudioUnlock). Every
// entry point degrades to a silent no-op when Web Audio is unavailable (server
// render, unsupported browser) so it is safe to import anywhere.

let ctx: AudioContext | null = null;
let unlockInstalled = false;

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext;
}

function getContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

/**
 * Resume the AudioContext on the first user interaction so a later chime is
 * permitted to play under the browser autoplay policy. Safe to call repeatedly;
 * the listeners self-remove after the first gesture.
 */
export function installAudioUnlock(): void {
  if (unlockInstalled || typeof window === "undefined") return;
  unlockInstalled = true;
  const unlock = () => {
    void getContext()
      ?.resume()
      .catch(() => {});
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}

/** Schedule one short sine note on the shared context. */
function note(context: AudioContext, freq: number, start: number, duration: number): void {
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  // Quick attack, exponential release — a soft "ding" rather than a click.
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(context.destination);
  osc.start(start);
  osc.stop(start + duration);
}

/**
 * Play the needs-human chime. No-ops silently when Web Audio is unavailable or
 * the context is still suspended (no user gesture yet).
 */
export function playChime(): void {
  const context = getContext();
  if (context?.state !== "running") return;
  const t = context.currentTime;
  note(context, 660, t, 0.18); // E5
  note(context, 880, t + 0.16, 0.22); // A5
}

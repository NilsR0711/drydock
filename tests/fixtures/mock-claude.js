#!/usr/bin/env node
// Mock `claude -p ... --output-format stream-json --verbose`.
// Emits a small realistic NDJSON stream, sleeps ~2s, exits 0.
// Used by Phase 2 lifecycle tests so no real Claude CLI is invoked.

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

emit({ type: "system", subtype: "init", session_id: "mock-sess-001", model: "mock-model" });
emit({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "Working on the issue." }] },
});
emit({
  type: "result",
  subtype: "success",
  session_id: "mock-sess-001",
  total_cost_usd: 0.0123,
  usage: { input_tokens: 1000, output_tokens: 500 },
});

setTimeout(() => process.exit(0), 2000);

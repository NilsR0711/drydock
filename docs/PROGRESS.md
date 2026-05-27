# AutoClaude — Progress

Phase tracking. Continuously maintained; survives context compaction.

## Phases

- [x] Phase 0 – Bootstrap
- [x] Phase 1 – DB + Repos CRUD
- [x] Phase 2 – Orchestrator skeleton + job lifecycle (mock Claude)
- [ ] Phase 3 – Stream-JSON parser + SSE broker
- [ ] Phase 4 – Real Claude subprocess + cost tracking
- [ ] Phase 5 – CI babysitter + auto-merge
- [ ] Phase 6 – Prompt editor
- [ ] Phase 7 – ADR review queue
- [ ] Phase 8 – Polish + robustness

## Current focus

Phase 2 complete. Next: Phase 3 (stream-json parser + SSE broker + live log viewer).

## Last 5 actions

- State machine (allow-list transitions) + transitionJob writer logging events.
- Jobs service (create/get/transition/next-queued); mock-claude.js fixture.
- runMockSession lifecycle + crash recovery (in-flight -> interrupted).
- Job-detail page (status + timeline); singleton runs recovery on start.
- ADR 005/006; 22 tests green; biome + build green. Tag phase-2.

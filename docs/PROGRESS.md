# AutoClaude — Progress

Phase tracking. Continuously maintained; survives context compaction.

## Phases

- [x] Phase 0 – Bootstrap
- [x] Phase 1 – DB + Repos CRUD
- [x] Phase 2 – Orchestrator skeleton + job lifecycle (mock Claude)
- [x] Phase 3 – Stream-JSON parser + SSE broker
- [x] Phase 4 – Real Claude subprocess + cost tracking
- [x] Phase 5 – CI babysitter + auto-merge
- [x] Phase 6 – Prompt editor
- [x] Phase 7 – ADR review queue
- [ ] Phase 8 – Polish + robustness

## Current focus

Phase 7 complete. Next: Phase 8 (graceful shutdown, crash recovery wiring, DB backup, global pause, daily-cost limit, README).

## Last 5 actions

- ADR service (parseAdrTitle, idempotent registerAdr, approve/reject, pendingCount).
- chokidar v4 watcher (dir watch + .md filter, no globs) with real temp-dir test.
- /adrs review UI (react-markdown) + approve/reject actions + header pending badge.
- Switched lang/metadata to English.
- ADR 011; 61 tests green; biome + build green. Tag phase-7.

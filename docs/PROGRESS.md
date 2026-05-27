# Drydock — Progress

Phase tracking. Continuously maintained.

## Phases

- [x] Phase 0 – Bootstrap
- [x] Phase 1 – DB + Repos CRUD
- [x] Phase 2 – Orchestrator skeleton + job lifecycle (mock Claude)
- [x] Phase 3 – Stream-JSON parser + SSE broker
- [x] Phase 4 – Real Claude subprocess + cost tracking
- [x] Phase 5 – CI babysitter + auto-merge
- [x] Phase 6 – Prompt editor
- [x] Phase 7 – ADR review queue
- [x] Phase 8 – Polish + robustness

## Current focus

All phases P0-P8 complete. Project done: 70 tests, biome clean, build green, dev serves on 127.0.0.1:3737.

## Last 5 actions

- Settings service (global pause + daily-cost gate) + settings UI/action.
- DB backup with 7-day retention (runBackup) + `pnpm backup` script.
- Graceful shutdown (SIGINT/SIGTERM -> interrupted + subprocess SIGTERM) + abort registry.
- README quickstart; abort wired into spawnClaudeSession.
- ADR 012; 70 tests green; biome + build green. Tag phase-8.

# AutoClaude — Progress

Phase tracking. Continuously maintained; survives context compaction.

## Phases

- [x] Phase 0 – Bootstrap
- [x] Phase 1 – DB + Repos CRUD
- [ ] Phase 2 – Orchestrator skeleton + job lifecycle (mock Claude)
- [ ] Phase 3 – Stream-JSON parser + SSE broker
- [ ] Phase 4 – Real Claude subprocess + cost tracking
- [ ] Phase 5 – CI babysitter + auto-merge
- [ ] Phase 6 – Prompt editor
- [ ] Phase 7 – ADR review queue
- [ ] Phase 8 – Polish + robustness

## Current focus

Phase 1 complete. Next: Phase 2 (orchestrator skeleton, state machine, mock-claude job lifecycle).

## Last 5 actions

- Full Drizzle schema (7 tables) + generated migration 0000.
- createDb factory (in-memory for tests), queries, repos service (add/update/remove).
- GhClient wrapper with injectable runner; Server Actions for CRUD + issue sync.
- Vendored UI primitives (button/card/badge), RepoList + dashboard wired.
- ADR 003/004; 12 tests green; biome + build green. Tag phase-1.

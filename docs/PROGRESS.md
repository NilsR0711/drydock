# AutoClaude — Progress

Phase tracking. Continuously maintained; survives context compaction.

## Phases

- [x] Phase 0 – Bootstrap
- [x] Phase 1 – DB + Repos CRUD
- [x] Phase 2 – Orchestrator skeleton + job lifecycle (mock Claude)
- [x] Phase 3 – Stream-JSON parser + SSE broker
- [x] Phase 4 – Real Claude subprocess + cost tracking
- [x] Phase 5 – CI babysitter + auto-merge
- [ ] Phase 6 – Prompt editor
- [ ] Phase 7 – ADR review queue
- [ ] Phase 8 – Polish + robustness

## Current focus

Phase 5 complete. Next: Phase 6 (prompt editor: Monaco, template CRUD, versioning, variable preview).

## Last 5 actions

- classifyChecks (pending/passed/failed) + ciBabysitter poll loop.
- Auto-merge on green; retry-with-Haiku (buildResumeArgs) up to 3.
- Max-retries -> needs_human + issue comment + follow-up issue row.
- Injected gh/resume/sleep for deterministic tests (7 new).
- ADR 009; 50 tests green; biome + build green. Tag phase-5.

# AutoClaude — Progress

Phase tracking. Continuously maintained; survives context compaction.

## Phases

- [x] Phase 0 – Bootstrap
- [x] Phase 1 – DB + Repos CRUD
- [x] Phase 2 – Orchestrator skeleton + job lifecycle (mock Claude)
- [x] Phase 3 – Stream-JSON parser + SSE broker
- [ ] Phase 4 – Real Claude subprocess + cost tracking
- [ ] Phase 5 – CI babysitter + auto-merge
- [ ] Phase 6 – Prompt editor
- [ ] Phase 7 – ADR review queue
- [ ] Phase 8 – Polish + robustness

## Current focus

Phase 3 complete. Next: Phase 4 (real claude spawn streaming + pricing + cost dashboard).

## Last 5 actions

- StreamJsonParser (buffered NDJSON, Zod-validated, token/cost accumulation).
- 3 NDJSON fixtures (success/tool-use/error, 22-31 events each).
- LogBroker (persist + fan-out + replay-200); SSE Route Handler.
- LogViewer (react-virtuoso) wired into job-detail page.
- ADR 007; 34 tests green; biome + build green. Tag phase-3.

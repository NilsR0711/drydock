# AutoClaude — Progress

Phase tracking. Continuously maintained; survives context compaction.

## Phases

- [x] Phase 0 – Bootstrap
- [x] Phase 1 – DB + Repos CRUD
- [x] Phase 2 – Orchestrator skeleton + job lifecycle (mock Claude)
- [x] Phase 3 – Stream-JSON parser + SSE broker
- [x] Phase 4 – Real Claude subprocess + cost tracking
- [ ] Phase 5 – CI babysitter + auto-merge
- [ ] Phase 6 – Prompt editor
- [ ] Phase 7 – ADR review queue
- [ ] Phase 8 – Polish + robustness

## Current focus

Phase 4 complete. Next: Phase 5 (CI babysitter, retry-with-Haiku, followup issues, auto-merge).

## Last 5 actions

- pricing.ts (Sonnet/Haiku rates, dated 2026-05) + estimateCost.
- StreamRunner abstraction (SIGTERM->SIGKILL abort) + spawnClaudeSession streaming.
- Cost source: total_cost_usd else token estimate; persisted to job.
- cost-queries (daily/by-model/top/today) + /costs dashboard (recharts).
- ADR 008; 43 tests green; biome + build green. Tag phase-4.

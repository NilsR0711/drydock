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
- [ ] Phase 7 – ADR review queue
- [ ] Phase 8 – Polish + robustness

## Current focus

Phase 6 complete. Next: Phase 7 (ADR review queue: chokidar watcher, react-markdown, approve/reject).

## Last 5 actions

- render.ts (pure variable substitution, client-safe) + templates.ts re-export.
- Template versioning (append + prune to 20), getActive/listVersions.
- Monaco PromptEditor with live sample-data preview + save action.
- /prompts page wired; fixed client/server import boundary (no better-sqlite3 in bundle).
- ADR 010; 55 tests green; biome + build green. Tag phase-6.

# ADR 011: ADR detection via chokidar + review queue

- **Status:** accepted
- **Date:** 2026-05-27

## Context

Jobs may emit ADRs into the target repo's `docs/adr/`. We must detect new ADR
files, queue them for human review, and render them. chokidar v4 removed glob
support, so the watch pattern must change.

## Decision

`watchAdrDirs` watches each repo's `docs/adr/` directory (depth 0, ignoreInitial)
and filters `.md` in the handler — no globs. On `add`, the file is read and
registered via `registerAdr`, which is idempotent per `file_path` (add+change
won't duplicate) and extracts the title from the first markdown H1. ADRs start
`pending_review`; the `/adrs` page renders them with react-markdown and offers
approve / reject+comment. A header badge shows the pending count.

## Consequences

- Compatible with chokidar v4; no glob dependency.
- Idempotent registration tolerates duplicate FS events.
- Rejection comments are appended to the row title to keep reviewer context
  without a new column.

# AutoClaude — Spec

> Diese Datei ist die Single Source of Truth für den Build. Wird vom Build-Goal als Context geladen. Nicht ohne Grund ändern.

---

## 1. Ziel

Eine lokal laufende Web-App auf `http://localhost:3737`, mit der ich GitHub-Repos verwalte und Issues autonom durch Claude-Code-Sessions abarbeiten lasse — inklusive CI-Babysitting, Auto-Merge, ADR-Review, Live-Logs, Cost-Tracking und Prompt-Editor.

Zielgruppe: ein Nutzer (ich, lokal). Keine Auth, keine Cloud, kein Multi-User.

---

## 2. Tech-Stack (gesetzt)

- **Runtime:** Node.js 22 LTS + pnpm
- **Framework:** Next.js 15 (App Router, RSC + Server Actions)
- **DB:** SQLite via `better-sqlite3` (synchron, embedded, eine Datei `./data/autoclaude.db`)
- **Migrations:** `drizzle-orm` + `drizzle-kit`
- **UI:** Tailwind v4 + shadcn/ui (New York style, Neutral)
- **Realtime:** Server-Sent Events (SSE) für Live-Logs
- **State (Client):** RSC wo möglich, `nuqs` für URL-State, `zustand` nur wenn nötig
- **Process-Management:** Native `node:child_process` (`spawn`)
- **GitHub:** `gh` CLI als Subprocess
- **Validation:** Zod
- **Tests:** Vitest (Playwright optional, kein Blocker)
- **Lint/Format:** Biome

**Verzeichnisstruktur:**
```
.
├── src/
│   ├── app/                    # Next.js App Router
│   ├── components/             # shadcn + custom
│   ├── lib/
│   │   ├── db/                 # Schema, Migrations, Queries
│   │   ├── orchestrator/       # Core (claude spawn, CI watch, queue)
│   │   ├── github/             # gh-CLI Wrapper
│   │   └── stream/             # SSE-Broker, Log-Parser
│   └── instrumentation.ts      # Startet Orchestrator-Singleton
├── data/                       # SQLite + Logs (gitignored)
├── docs/
│   ├── adr/                    # ADRs
│   └── PROGRESS.md             # Phasen-Tracking, kontinuierlich gepflegt
└── tests/
```

---

## 3. Architektur

```
Browser (localhost:3737)
  ├─ Dashboard, Job-Detail, Prompt-Editor, ADR-Queue, Cost-Dashboard
  ▼
Next.js (RSC + Server Actions + SSE Routes)
  ├─ instrumentation.ts → Orchestrator-Singleton
  ▼
SQLite ◀──▶ Orchestrator ◀──▶ Log-Broker (SSE pub/sub)
                  │
                  ▼
           claude -p (spawn, stream-json)
                  │
                  ▼
            gh CLI (PR, CI, comments)
```

Orchestrator-Singleton: instrumentation.ts initialisiert einmalig. Map<jobId, RunningJob>. State-Machine pro Job: `queued → working → ci_running → ci_failed → retrying → merged | needs_human | aborted`. CI-Poll alle 30s. Bei Server-Restart: Jobs mit `working`/`ci_running` → `interrupted`.

---

## 4. Datenmodell (Drizzle Schema)

```ts
repos              // id, path, name, default_branch, queue_label, working_label, needs_human_label
prompt_templates   // id, repo_id, name, content, updated_at
jobs               // id, repo_id, issue_number, status, branch, pr_number, session_id,
                   //   started_at, finished_at, model, max_turns,
                   //   total_input_tokens, total_output_tokens, cost_usd,
                   //   ci_retry_count, error_message
job_events         // id, job_id, ts, type, payload (JSON)  -- append-only, INDEX (job_id, ts)
adrs               // id, job_id, file_path, title, status, created_at
followup_issues    // id, job_id, gh_issue_number, title, created_at
settings           // key, value (JSON)
```

---

## 5. Features (UI-Screens)

### 5.1 Dashboard (`/`)
Repo-Liste. Pro Repo: Anzahl Issues mit Queue-Label, aktive Jobs, letzte 5 Runs mit Status-Badges. Buttons: "Sync Issues" (`gh issue list`), "Start Queue".

### 5.2 Repo-Detail (`/repos/[id]`)
Tabs: Queue (Issues mit Queue-Label, Drag-to-Reorder), Active (laufende Jobs), History, Settings (Pfad, Labels, Default-Model).

### 5.3 Job-Detail (`/jobs/[id]`)
Live-Log-Viewer (SSE, virtualisiert via react-virtuoso). Status-Timeline. Cost-Anzeige live. Tool-Use-Calls collapsible. Actions: Abort (SIGTERM, dann SIGKILL nach 5s), Retry, Comment on Issue, View PR, Mark needs-human.

### 5.4 Prompt-Editor (`/prompts`)
Monaco-Editor mit Markdown-Syntax. Variablen-Hint (`$ISSUE_NUM`, `$BRANCH`, `$REPO_NAME`). Test-Button (Render mit Beispieldaten). Versions-History (max. 20).

### 5.5 ADR-Review-Queue (`/adrs`)
Liste neuer ADRs (Status `pending_review`). Markdown-Renderer + File-Link. Buttons: Approve, Reject+Comment. Badge im Header zeigt Anzahl ungelesener.

### 5.6 Cost-Dashboard (`/costs`)
Tageschart (recharts) Tokens + USD. Pro Repo + pro Model. Top-10-Jobs der letzten 30 Tage. Warning bei Tages-Cost > Limit.

### 5.7 Settings (`/settings`)
Default-Model, Cost-Limit, Poll-Interval, Max-Turns, CLI-Paths, globale Pause.

---

## 6. Core-Logik: der Orchestrator

### 6.1 Driver-Loop (pro Repo)
```
loop:
  if paused or daily_cost > limit: sleep 60s, continue
  next_issue = ältestes Issue mit Queue-Label, priority DESC
  if none: sleep 30s, continue
  job = create_job(issue)
  label: Queue → Working
  spawn_claude_session(job)  // returns sofort; ci_babysitter async
```

### 6.2 spawn_claude_session(job)
`cwd` = repo.path. Command:
```
claude -p <prompt> --max-turns 40 --permission-mode acceptEdits \
  --model <model> --output-format stream-json --verbose
```
stdout: zeilenweise NDJSON-Parse → jedes Event in `job_events` + SSE-Broker push. Cost-Tracking: aus `message.usage`-Events kumulieren × Pricing. Exit-Handler: Code 0 → PR suchen → ci_babysitter; sonst → `needs_human`.

### 6.3 ci_babysitter(job, pr_number)
Poll alle 30s `gh pr checks <pr>`. Alle grün → warten auf merged. Eine rot → wenn retry_count < 3: Failed-Log holen (`gh run view --log-failed | tail -c 8000`), `claude -p "CI failed..." --resume <session_id> --max-turns 15 --model claude-haiku-4-5`, retry_count++. Sonst → `needs_human` + Issue-Comment.

### 6.4 Stream-JSON-Parser
NDJSON-Events: `system` (session_id extrahieren), `assistant` (Text + Tool-Use), `user` (Tool-Results), `result` (final cost+tokens). Jedes Event → Row + Broadcast.

### 6.5 ADR-Detection
`chokidar` auf `<repo>/docs/adr/`. Neue Datei → Row in `adrs` mit status=`pending_review`.

---

## 7. SSE-Broker (`lib/stream/broker.ts`)

```ts
broker.subscribe(jobId, controller)
broker.publish(jobId, event)   // persistiert + pusht
broker.unsubscribe(jobId, controller)
```

Route Handler `app/api/sse/jobs/[id]/route.ts`: Replay letzte 200 Events aus DB, dann subscribe. AbortSignal → unsubscribe.

---

## 8. Security & Robustness

- Next.js bindet nur `127.0.0.1`
- `claude -p` mit `acceptEdits` (nicht `bypassPermissions`), `cwd` = repo path
- Graceful Shutdown: SIGINT → Jobs als `interrupted`, Subprozesse SIGTERM, 5s, SIGKILL
- Crash-Recovery: bei Start → working/ci_running → interrupted (Restart-Button)
- DB-Backup: `cp` täglich, 7 Tage Retention
- Max. 3 parallele Jobs (konfigurierbar)

---

## 9. Konventionen

- **TDD strikt:** Test vor Implementation. Vitest für Unit.
- **Conventional Commits:** `feat(orchestrator):`, `fix(ui):`, `test(stream):` etc.
- **Ein Commit pro logischer Einheit.** Phasen-Ende = Tag + Eintrag in PROGRESS.md.
- **ADRs:** nicht-triviale Entscheidung → `docs/adr/NNN-slug.md` (Context / Decision / Consequences). Pflicht für: DB-Wahl, SSE vs. WebSocket, Stream-Parser-Strategie, State-Machine-Design, Process-Singleton-Pattern, Cost-Tracking-Quelle, CI-Retry-Strategie, Crash-Recovery.
- **`strict` + `noUncheckedIndexedAccess`. Kein `any`.**
- **Server Actions für Mutations.** Route Handlers nur für SSE.
- **Code-Kommentare nur WARUM, nicht WAS.**

---

## 10. Phasen

Jede Phase endet mit Eintrag in `docs/PROGRESS.md` (`[x] Phase N – Title`), Commit `chore: complete phase N`, Tag `phase-N`.

### Phase 0: Bootstrap
- `pnpm create next-app`, Tailwind v4, shadcn init (button, card, badge, table, tabs, dialog, sonner, scroll-area, separator, sheet), Biome, Vitest, drizzle setup
- `instrumentation.ts` Stub
- `docs/adr/000-template.md` + ADR 001 "Tech Stack Selection"
- `docs/PROGRESS.md` mit allen 8 Phasen als unchecked
- **Acceptance:** `pnpm test` (≥1 trivial test grün), `pnpm build` grün, `pnpm dev` startet, leere `/` rendert

### Phase 1: DB + Repos-CRUD
- Drizzle-Schema komplett, Migrations
- Server Actions: addRepo, removeRepo, updateRepo
- UI: Repo-Liste, Add-Dialog
- gh-CLI-Wrapper (`gh issue list --label X --json ...`)
- **Acceptance:** Repo-CRUD funktioniert, Issues syncen funktioniert, Tests grün

### Phase 2: Orchestrator-Skeleton + Job-Lifecycle (Mock-Claude)
- State-Machine vollständig
- Mock-Claude (Subprocess der nach 5s exit 0)
- Driver-Loop im Hintergrund
- Job-Detail zeigt Status-Wechsel
- **Acceptance:** Mock-Job läuft durch alle States, DB-Rows korrekt, Tests grün

### Phase 3: Stream-JSON-Parser + SSE-Broker
- Parser-Modul + Unit-Tests gegen Fixture-Samples in `tests/fixtures/stream-json/` (Samples: lege drei realistische NDJSON-Streams an mit je 20-50 Events: einer für erfolgreichen Run, einer mit Tool-Use, einer mit Fehler)
- SSE-Broker mit Replay + Live
- Live-Log-Viewer (react-virtuoso)
- **Acceptance:** Fixture-Replay zeigt Events smooth in UI, Parser-Tests grün

### Phase 4: Echter Claude-Subprocess + Cost-Tracking
- `spawnClaudeSession` produktiv
- Pricing in `lib/orchestrator/pricing.ts` mit Datum-Kommentar (Sonnet 4.5: $3/$15 per MTok input/output, Haiku 4.5: $1/$5 — als Konstante, leicht updatebar)
- Cost-Dashboard `/costs`
- **Acceptance:** Live `claude -p "echo hi" --output-format stream-json --verbose` läuft, Cost in UI sichtbar. Falls Anthropic-Key nicht verfügbar: Test mit Stub der echte stream-json schreibt.

### Phase 5: CI-Babysitter + Auto-Merge
- gh pr checks polling
- Retry-Loop mit Haiku
- Followup-Issue-Creation
- **Acceptance:** Mock-PR (lokales Test-Repo) durchläuft Babysitter-Loop, Tests grün

### Phase 6: Prompt-Editor
- Monaco-Integration (`@monaco-editor/react`)
- Template-CRUD + Versions-History
- Variable-Substitution mit Preview
- **Acceptance:** Template ändern → DB-Row für Version, nächster Job nutzt neue Version, Tests grün

### Phase 7: ADR-Review-Queue
- chokidar-Watcher
- Review-UI mit Markdown-Render (`react-markdown`)
- **Acceptance:** Mock-Schreibvorgang in `<repo>/docs/adr/` → Row erscheint → Approve-Flow funktioniert, Tests grün

### Phase 8: Polish + Robustness
- Graceful Shutdown, Crash-Recovery, DB-Backup-Skript
- Globale Pause, Daily-Cost-Limit
- README mit Quickstart
- **Acceptance:** `pnpm start` produktiv nutzbar, alle Tests grün, `pnpm build` grün

---

## 11. Wann ist AutoClaude FERTIG?

Hard checks die der `/goal`-Evaluator gegen das Transcript prüft:

1. `pnpm install` exit 0
2. `pnpm test` exit 0
3. `pnpm build` exit 0
4. `cat docs/PROGRESS.md` zeigt `[x]` für alle 8 Phasen (P0 bis P8)
5. `ls docs/adr/*.md | wc -l` ≥ 9 (Template + 8 ADRs minimum)
6. `git tag --list 'phase-*' | wc -l` = 9 (phase-0 bis phase-8)
7. `pnpm dev &` startet und `curl -sf http://localhost:3737/` returnt HTTP 200

Alle 7 Checks im Terminal-Output sichtbar = goal erfüllt.

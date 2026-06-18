# Changelog

## [0.1.7](https://github.com/NilsR0711/drydock/compare/v0.1.6...v0.1.7) (2026-06-18)


### Features

* **analytics:** slice outcomes by model, agent, and prompt version ([#178](https://github.com/NilsR0711/drydock/issues/178)) ([4cdfa72](https://github.com/NilsR0711/drydock/commit/4cdfa726f69ecb8796e22d6eacadd682da02914c))
* **cli:** run Drydock as a background daemon (start/stop/status/restart) ([#228](https://github.com/NilsR0711/drydock/issues/228)) ([2666de5](https://github.com/NilsR0711/drydock/commit/2666de53eb2991b7f4795c8fa2e19897c3cb6796))
* **dashboard:** proactive Codex OAuth usage gauge ([#189](https://github.com/NilsR0711/drydock/issues/189)) ([#227](https://github.com/NilsR0711/drydock/issues/227)) ([4b5ab77](https://github.com/NilsR0711/drydock/commit/4b5ab772b4b6ba050fecde6ae8ee67d10b8e5bb0))
* opt-in sandboxed agent execution (Docker/Podman isolation) ([#182](https://github.com/NilsR0711/drydock/issues/182)) ([#226](https://github.com/NilsR0711/drydock/issues/226)) ([fbe6a17](https://github.com/NilsR0711/drydock/commit/fbe6a171116fa88de0ad1d65823fc01750cb3008))
* **orchestrator:** generate meaningful PR title, body, and commit from agent-authored .drydock/PR.md ([#212](https://github.com/NilsR0711/drydock/issues/212)) ([#222](https://github.com/NilsR0711/drydock/issues/222)) ([d4af43a](https://github.com/NilsR0711/drydock/commit/d4af43afd1857d8577703281b54daac32388a2a2))
* proactive Claude OAuth usage indicator in the dashboard ([#188](https://github.com/NilsR0711/drydock/issues/188)) ([#225](https://github.com/NilsR0711/drydock/issues/225)) ([a94abc1](https://github.com/NilsR0711/drydock/commit/a94abc1fbfcc4966cd38ef9ad3aa9f5b94492742))
* **repos:** default review feedback ON for autonomous operation ([#213](https://github.com/NilsR0711/drydock/issues/213)) ([#221](https://github.com/NilsR0711/drydock/issues/221)) ([94053c2](https://github.com/NilsR0711/drydock/commit/94053c26155378a011a5a503d21306995ef483a6))


### Bug Fixes

* **build:** boot the standalone server (trace metadata runtime + smoke test) ([#209](https://github.com/NilsR0711/drydock/issues/209)) ([#223](https://github.com/NilsR0711/drydock/issues/223)) ([3273bde](https://github.com/NilsR0711/drydock/commit/3273bdea78219374e0f5b50d613c3013417f9686))
* **ci:** drop registry-url so npm uses OIDC trusted publishing ([#198](https://github.com/NilsR0711/drydock/issues/198)) ([6d5cc7b](https://github.com/NilsR0711/drydock/commit/6d5cc7b8c43d41949f16ff5006241ed74df057b3))
* **dev:** run the dev server on webpack with a capped heap ([#215](https://github.com/NilsR0711/drydock/issues/215)) ([0a6ebb3](https://github.com/NilsR0711/drydock/commit/0a6ebb33f113e370bdfa20681dee094773949a6c)), closes [#204](https://github.com/NilsR0711/drydock/issues/204)
* **orchestrator:** allow opt-in auto-merge for repos with no CI checks ([#207](https://github.com/NilsR0711/drydock/issues/207)) ([#219](https://github.com/NilsR0711/drydock/issues/219)) ([17e738f](https://github.com/NilsR0711/drydock/commit/17e738ff362ee0b687831b2e011a0bd9b0442574))
* **orchestrator:** embed issue title and body in the implement prompt ([#205](https://github.com/NilsR0711/drydock/issues/205)) ([1585291](https://github.com/NilsR0711/drydock/commit/158529184e9d4bafff92882fde213196ca3cc2c5))
* **orchestrator:** reclaim stale instance.lock after crash / pid reuse ([#220](https://github.com/NilsR0711/drydock/issues/220)) ([dd06b64](https://github.com/NilsR0711/drydock/commit/dd06b6454ea0b0f5bac691b2161a50b81ac8fdc8))
* **repos:** detect default branch on add instead of hardcoding "main" ([#210](https://github.com/NilsR0711/drydock/issues/210)) ([#224](https://github.com/NilsR0711/drydock/issues/224)) ([0b2d9e6](https://github.com/NilsR0711/drydock/commit/0b2d9e628d63cb94d4a5b7074188a3d4fa206e1b))
* **ui:** render Section icon as ReactNode to fix RSC crash on /repos/[id] ([#214](https://github.com/NilsR0711/drydock/issues/214)) ([0e99504](https://github.com/NilsR0711/drydock/commit/0e995042688a850f00bd01302e8470c845af8917)), closes [#208](https://github.com/NilsR0711/drydock/issues/208)
* **worktree:** preserve agent work when the agent commits ("Agent produced no changes") ([#218](https://github.com/NilsR0711/drydock/issues/218)) ([371c43c](https://github.com/NilsR0711/drydock/commit/371c43ce2de1014deaf7bd1fe4773563ec1b3ce7))

## [0.1.6](https://github.com/NilsR0711/drydock/compare/v0.1.5...v0.1.6) (2026-06-11)


### Features

* **api:** health endpoint with machine-readable orchestrator metrics ([#195](https://github.com/NilsR0711/drydock/issues/195)) ([9699001](https://github.com/NilsR0711/drydock/commit/969900159bd79e3a0ae3e2aa7833fe9f2908c477)), closes [#183](https://github.com/NilsR0711/drydock/issues/183)
* **cli:** ops subcommands for packaged installs — backup/restore, doctor, service install ([#194](https://github.com/NilsR0711/drydock/issues/194)) ([e6b35d9](https://github.com/NilsR0711/drydock/commit/e6b35d9892d577cb9d736124e6989dc9f4943505)), closes [#176](https://github.com/NilsR0711/drydock/issues/176)
* **forge:** event-driven webhook nudges — wake CI babysitter, merge gate, and review sweep ([#192](https://github.com/NilsR0711/drydock/issues/192)) ([e3d4ba9](https://github.com/NilsR0711/drydock/commit/e3d4ba9ab5146fb53b336b69d92039c2168f6460))
* **models:** add Claude Fable 5 and Sonnet 4.6, fix Opus 4.7 pricing ([#161](https://github.com/NilsR0711/drydock/issues/161)) ([788ea8e](https://github.com/NilsR0711/drydock/commit/788ea8eceed713c896a25349b69716f6c36be0c4)), closes [#157](https://github.com/NilsR0711/drydock/issues/157)
* OpenRouter API backend with auto-syncing model catalog, incl. free models ([#187](https://github.com/NilsR0711/drydock/issues/187)) ([930595d](https://github.com/NilsR0711/drydock/commit/930595d229616efc084cdf91cf99829534915501))
* opt-in AI PR audit — read-only whole-PR review posted to the issue (Claude or Codex, locale-aware) ([#186](https://github.com/NilsR0711/drydock/issues/186)) ([08d125d](https://github.com/NilsR0711/drydock/commit/08d125d74d304f807e2e61b8cf312d55efe7425f))
* **orchestrator:** branch & PR janitor — delete merged remote branches, refresh stale or conflicted PRs ([#193](https://github.com/NilsR0711/drydock/issues/193)) ([671cc55](https://github.com/NilsR0711/drydock/commit/671cc5531e7be5f43082be8c72aec7ec84311584))
* **orchestrator:** credential watchdog — detect expired gh/GitLab/agent auth before the queue dies ([#190](https://github.com/NilsR0711/drydock/issues/190)) ([7a528e3](https://github.com/NilsR0711/drydock/commit/7a528e3151e4ebd4b130a131a494eb35b8ecd6a9))
* **orchestrator:** detect Claude usage limits, park jobs, and auto-resume when quota resets ([#184](https://github.com/NilsR0711/drydock/issues/184)) ([50f5400](https://github.com/NilsR0711/drydock/commit/50f540090fc41192addda245b4e04ad7d3d23947))
* **orchestrator:** detect Codex CLI usage limits, park jobs, and auto-resume when quota resets ([#185](https://github.com/NilsR0711/drydock/issues/185)) ([5b6ca36](https://github.com/NilsR0711/drydock/commit/5b6ca3615e0062d42f9b497139c26355c21164f1)), closes [#167](https://github.com/NilsR0711/drydock/issues/167)
* **orchestrator:** model escalation ladder — retry failed jobs with a stronger model ([#191](https://github.com/NilsR0711/drydock/issues/191)) ([3cc0def](https://github.com/NilsR0711/drydock/commit/3cc0defdd72f0a6f3190090291f4e9bd19e2611d))
* **orchestrator:** opt-in plan-first stage before implementation ([#164](https://github.com/NilsR0711/drydock/issues/164)) ([34fab07](https://github.com/NilsR0711/drydock/commit/34fab07cc62a1bea9b15e1a883639ed11a5d2005)), closes [#160](https://github.com/NilsR0711/drydock/issues/160)
* **orchestrator:** review settle gate before auto-merge ([#163](https://github.com/NilsR0711/drydock/issues/163)) ([a86fbb3](https://github.com/NilsR0711/drydock/commit/a86fbb3ceca4000c994707b1df3d2ca90efec7ac)), closes [#159](https://github.com/NilsR0711/drydock/issues/159)
* **review-feedback:** trusted-bots allowlist so bot findings can be processed ([#162](https://github.com/NilsR0711/drydock/issues/162)) ([528ff2b](https://github.com/NilsR0711/drydock/commit/528ff2bddd30deb3815e56590911c98b36130baf)), closes [#158](https://github.com/NilsR0711/drydock/issues/158)
* **ui:** finish design-epic remnants — route boundaries, empty states, fieldset settings ([#165](https://github.com/NilsR0711/drydock/issues/165)) ([a27173f](https://github.com/NilsR0711/drydock/commit/a27173fbda63a2b1970b233c4cf1e9a9876b0755))


### Bug Fixes

* **actions:** dedupe manual starts, guard destructive actions, confine symlinked browsing ([#174](https://github.com/NilsR0711/drydock/issues/174)) ([4eef83d](https://github.com/NilsR0711/drydock/commit/4eef83d9ecab625577b0cd188c88a8a61386a9e2))
* **ci-heal:** abort-aware babysitting, healing slot leaks, review-feedback recovery, squash-merge monitoring ([#172](https://github.com/NilsR0711/drydock/issues/172)) ([74f219d](https://github.com/NilsR0711/drydock/commit/74f219d6e6b0091d46d8e0bf71890a3896c22093))
* **ci-heal:** make rerun action real, close progressed sessions, guard session reuse ([#153](https://github.com/NilsR0711/drydock/issues/153)) ([4b77679](https://github.com/NilsR0711/drydock/commit/4b7767923ea881d5f7b7a0460323b3082426659c))
* **db:** migration FK enforcement, prune variable limit, complete cost accounting ([#170](https://github.com/NilsR0711/drydock/issues/170)) ([236d5ca](https://github.com/NilsR0711/drydock/commit/236d5cab5d60d57f8b15a7aad78a0fc2c00903b7))
* **db:** transactional reorder, LIKE escaping, repo-scoped ADR dedup, per-repo time limits ([#155](https://github.com/NilsR0711/drydock/issues/155)) ([07757e6](https://github.com/NilsR0711/drydock/commit/07757e64a1f67d110f71677911219f6d906d37d3))
* **forge:** GitLab pagination, ETag paging, SSE resilience, redaction correctness ([#173](https://github.com/NilsR0711/drydock/issues/173)) ([c142bed](https://github.com/NilsR0711/drydock/commit/c142bed46924d88b138fe85b32b333e9dffa4879))
* **orchestrator:** recover ci_failed jobs, abort race, parked-job enqueue churn ([#152](https://github.com/NilsR0711/drydock/issues/152)) ([6b53c1a](https://github.com/NilsR0711/drydock/commit/6b53c1a72e8dfdfcd796bdecb3f8cfc2664c6f0f))
* **orchestrator:** worktree retry collision, recovery lock ordering, killed-session exit codes ([#171](https://github.com/NilsR0711/drydock/issues/171)) ([072690b](https://github.com/NilsR0711/drydock/commit/072690bc14a420177907f7e0123fa3e2db0f82f5))
* **security:** close IPv6 hex SSRF bypass, harden SSE job stream, fix cache token accounting ([#154](https://github.com/NilsR0711/drydock/issues/154)) ([109a1f6](https://github.com/NilsR0711/drydock/commit/109a1f6211d2411524621ab1857a10a758d526a5))
* **ui:** dialog focus trap, issue-board drop zones, pause sync, cost-limit input guard ([#175](https://github.com/NilsR0711/drydock/issues/175)) ([66761e2](https://github.com/NilsR0711/drydock/commit/66761e2a1c6aa1246a8744b8f8e062eea500bcfd))
* **ui:** drag-reorder corruption with active search, hydration mismatches, gauge and dialog fixes ([#156](https://github.com/NilsR0711/drydock/issues/156)) ([cdd154b](https://github.com/NilsR0711/drydock/commit/cdd154b422332b898ea49811559474214fc15591))

## [0.1.5](https://github.com/NilsR0711/drydock/compare/v0.1.4...v0.1.5) (2026-06-04)


### Features

* dark-first visual design overhaul ([#118](https://github.com/NilsR0711/drydock/issues/118)) ([#148](https://github.com/NilsR0711/drydock/issues/148)) ([8d87b9b](https://github.com/NilsR0711/drydock/commit/8d87b9b1df5ab0c512398d38f2fb4fa223f86c44))

## [0.1.4](https://github.com/NilsR0711/drydock/compare/v0.1.3...v0.1.4) (2026-06-01)


### Features

* **cost:** track untracked one-shot agent spend (issue [#95](https://github.com/NilsR0711/drydock/issues/95)) ([#127](https://github.com/NilsR0711/drydock/issues/127)) ([e4c62cd](https://github.com/NilsR0711/drydock/commit/e4c62cdc569b69a637f3af5493c3778585be4170))
* global job history view with search & filter (/jobs) ([#134](https://github.com/NilsR0711/drydock/issues/134)) ([e73a514](https://github.com/NilsR0711/drydock/commit/e73a5147a89ca553863b3a598c87b73352aae230))
* **models:** add Claude Opus 4.8 as selectable model and make it the default ([#123](https://github.com/NilsR0711/drydock/issues/123)) ([e856ea7](https://github.com/NilsR0711/drydock/commit/e856ea7c4ebd6b64dabc7aed94cd25679488fdd5))
* operator quick wins — navbar pause/resume, bulk queue actions, analytics ([#143](https://github.com/NilsR0711/drydock/issues/143)) ([8722004](https://github.com/NilsR0711/drydock/commit/8722004e8438ffb0eec34796de5b50f100dc3c9b))
* per-job model/agent override when queuing an issue ([#101](https://github.com/NilsR0711/drydock/issues/101)) ([#133](https://github.com/NilsR0711/drydock/issues/133)) ([e5c433d](https://github.com/NilsR0711/drydock/commit/e5c433d6040169762f57c0e2e7d93a2b2802bdfc))
* **prompts:** view, diff, and restore prompt versions ([#103](https://github.com/NilsR0711/drydock/issues/103)) ([1969484](https://github.com/NilsR0711/drydock/commit/1969484bb3c26bcd0e10b018664b44025f2136ed))


### Bug Fixes

* **a11y:** keyboard-operable queue actions on issue board ([#105](https://github.com/NilsR0711/drydock/issues/105)) ([#137](https://github.com/NilsR0711/drydock/issues/137)) ([cfe9d02](https://github.com/NilsR0711/drydock/commit/cfe9d024f78fce8aeec7b7771ebd07586f0831bc))
* **a11y:** modal dialogs focus trap, focus restore, and accessible name ([#136](https://github.com/NilsR0711/drydock/issues/136)) ([bf19de8](https://github.com/NilsR0711/drydock/commit/bf19de881a2f0289eed55b303a2127cf1cdbea42))
* **a11y:** status live regions, AA contrast, select labels & skip link ([#106](https://github.com/NilsR0711/drydock/issues/106)) ([#138](https://github.com/NilsR0711/drydock/issues/138)) ([e41943a](https://github.com/NilsR0711/drydock/commit/e41943ad6b6825ab5cbf1cdaf4ed11d2006bef25))
* abort kills the agent subprocess; add Stop control and emergency stop ([#121](https://github.com/NilsR0711/drydock/issues/121)) ([a8e0ce1](https://github.com/NilsR0711/drydock/commit/a8e0ce161974a9ead52e22dd05e4b39972c8c28f)), closes [#89](https://github.com/NilsR0711/drydock/issues/89)
* **agent-session:** drain grace-window stdout before finalising cost on force-abort ([#129](https://github.com/NilsR0711/drydock/issues/129)) ([d47827b](https://github.com/NilsR0711/drydock/commit/d47827b3dc7c6a8cbb42b08a7456dbe9523d4a98))
* **cost:** treat result-event usage as authoritative session total ([#119](https://github.com/NilsR0711/drydock/issues/119)) ([27893b9](https://github.com/NilsR0711/drydock/commit/27893b9512e9cef66b46502943ce920dc251ec94)), closes [#87](https://github.com/NilsR0711/drydock/issues/87)
* **cost:** UTC-vs-local daily window + CSV formula injection ([#107](https://github.com/NilsR0711/drydock/issues/107)) ([#139](https://github.com/NilsR0711/drydock/issues/139)) ([4875c61](https://github.com/NilsR0711/drydock/commit/4875c61a4d6166ab8d977c45927373336373465f))
* defense-in-depth — GitLab SSRF guard, log redaction, MCP add_repo path check ([#142](https://github.com/NilsR0711/drydock/issues/142)) ([57a4680](https://github.com/NilsR0711/drydock/commit/57a4680ee0cf1d963ac19e6351d117de1a0480aa)), closes [#110](https://github.com/NilsR0711/drydock/issues/110)
* enforce cumulative per-job cost cap across CI-fix resumes ([#126](https://github.com/NilsR0711/drydock/issues/126)) ([0724fe2](https://github.com/NilsR0711/drydock/commit/0724fe202ffb397c8a55f5068f59906078ca5a0b))
* **gitlab:** back off on 429 respecting Retry-After/RateLimit-Reset ([#131](https://github.com/NilsR0711/drydock/issues/131)) ([461b2d8](https://github.com/NilsR0711/drydock/commit/461b2d8261651d65cdf584b95e3221b87169fe0e))
* **gitlab:** remove deprecated merge param, use head_pipeline, log errors ([#108](https://github.com/NilsR0711/drydock/issues/108)) ([#140](https://github.com/NilsR0711/drydock/issues/140)) ([1380885](https://github.com/NilsR0711/drydock/commit/13808855c9fb9b817619d94e298bb561fa08a599))
* **notify:** bound notification I/O so it can't hang shutdown or saves ([#122](https://github.com/NilsR0711/drydock/issues/122)) ([59e310a](https://github.com/NilsR0711/drydock/commit/59e310a350e5aa1173ead58501008602576d2cca)), closes [#90](https://github.com/NilsR0711/drydock/issues/90)
* paginate issue listing so repos with &gt;100 open issues sync fully ([#120](https://github.com/NilsR0711/drydock/issues/120)) ([2b965da](https://github.com/NilsR0711/drydock/commit/2b965da099d322f13194c3a80f4e6424e244f850))
* reliability hardening — spawn-error surfacing, lease reclaim, shutdown race, migration latch ([#141](https://github.com/NilsR0711/drydock/issues/141)) ([58235aa](https://github.com/NilsR0711/drydock/commit/58235aaa52a118dfd005b3c917bade60535a89cb))
* **security:** confine directory picker to browse root (issue [#100](https://github.com/NilsR0711/drydock/issues/100)) ([#132](https://github.com/NilsR0711/drydock/issues/132)) ([6f81d45](https://github.com/NilsR0711/drydock/commit/6f81d455dfd0a3a94f3228ae3cee5b995baf3a33))
* **security:** refuse non-loopback --host without DRYDOCK_ALLOW_REMOTE ([#124](https://github.com/NilsR0711/drydock/issues/124)) ([d37ce4e](https://github.com/NilsR0711/drydock/commit/d37ce4e88eac256e49d3d2a1bbec8d12320dbc3e)), closes [#91](https://github.com/NilsR0711/drydock/issues/91)
* **subtasks:** park in-progress subtasks on every non-merge terminal outcome ([#128](https://github.com/NilsR0711/drydock/issues/128)) ([0668a4c](https://github.com/NilsR0711/drydock/commit/0668a4c5fbc77477085271604e92e6ab218412eb)), closes [#96](https://github.com/NilsR0711/drydock/issues/96)
* validate model ids and stop silent cheap-pricing fallback ([#93](https://github.com/NilsR0711/drydock/issues/93)) ([4dbc010](https://github.com/NilsR0711/drydock/commit/4dbc0104adf95b7018824cc0a94cc0e07a4febff))
* **worktree-reaper:** reap orphaned fb-*/dh-* worktrees on startup (issue [#98](https://github.com/NilsR0711/drydock/issues/98)) ([89c3070](https://github.com/NilsR0711/drydock/commit/89c30700b4434a04290d9a3849923839c124e9e1))

## [0.1.3](https://github.com/NilsR0711/drydock/compare/v0.1.2...v0.1.3) (2026-05-29)


### Features

* **cli:** report version status on `drydock update` ([#83](https://github.com/NilsR0711/drydock/issues/83)) ([#85](https://github.com/NilsR0711/drydock/issues/85)) ([f0968df](https://github.com/NilsR0711/drydock/commit/f0968df9bd08c5b71b96deb6a3af799bfb1c2cf6))


### Bug Fixes

* **cli:** run when invoked via symlink (global/npx installs) ([#84](https://github.com/NilsR0711/drydock/issues/84)) ([04c8229](https://github.com/NilsR0711/drydock/commit/04c82290450f6559b02918434a565fac60223a52))

## [0.1.2](https://github.com/NilsR0711/drydock/compare/v0.1.1...v0.1.2) (2026-05-29)


### Features

* ask-about-this-PR read-only QA agent ([#73](https://github.com/NilsR0711/drydock/issues/73)) ([dc3e344](https://github.com/NilsR0711/drydock/commit/dc3e34480bc0c73368c2a174f9248619c782c183))
* **ci:** richer CI failure classification & targeted fix prompts ([#80](https://github.com/NilsR0711/drydock/issues/80)) ([41745f9](https://github.com/NilsR0711/drydock/commit/41745f999a8b31fbab9e003fadb72ac76ec91bc4))
* exportable cost reports (CSV/JSON) ([#81](https://github.com/NilsR0711/drydock/issues/81)) ([fc37d69](https://github.com/NilsR0711/drydock/commit/fc37d69639f1bc1eef42547b4c7f5a929e4698a4)), closes [#63](https://github.com/NilsR0711/drydock/issues/63)
* in-dashboard update-available notice ([#58](https://github.com/NilsR0711/drydock/issues/58)) ([#76](https://github.com/NilsR0711/drydock/issues/76)) ([156c3f8](https://github.com/NilsR0711/drydock/commit/156c3f8fe5cc83b1efbd6f27d093f73e217f1c51))
* live multi-repo dashboard with per-repo spend and attention triage ([#78](https://github.com/NilsR0711/drydock/issues/78)) ([4cd65f5](https://github.com/NilsR0711/drydock/commit/4cd65f5e75b787fb9e30a90c4527797ec4832f10)), closes [#60](https://github.com/NilsR0711/drydock/issues/60)
* opt-in post-PR verification pass ([#54](https://github.com/NilsR0711/drydock/issues/54)) ([#72](https://github.com/NilsR0711/drydock/issues/72)) ([e952492](https://github.com/NilsR0711/drydock/commit/e952492da3c328763978352803290f05d688d49b))
* opt-in release management for watched repos (evaluate → version → publish) ([#77](https://github.com/NilsR0711/drydock/issues/77)) ([78491d5](https://github.com/NilsR0711/drydock/commit/78491d5b4b2b38c1723761bbb17b93d1cbdbf721))
* per-job cost ceiling that aborts a runaway session mid-stream ([#57](https://github.com/NilsR0711/drydock/issues/57)) ([f6fa3d9](https://github.com/NilsR0711/drydock/commit/f6fa3d900ad6254d576362f4bdc3427896d01f8e))
* per-repo custom agent instructions injected into the work prompt ([#74](https://github.com/NilsR0711/drydock/issues/74)) ([4fb00ba](https://github.com/NilsR0711/drydock/commit/4fb00ba97953b5315489be3f3eb44f4cdc2706b6))
* webhook-driven issue sync (opt-in, signature-verified, polling fallback) ([#79](https://github.com/NilsR0711/drydock/issues/79)) ([00c4261](https://github.com/NilsR0711/drydock/commit/00c4261f63291a2e919356bfb39116b561a87227))


### Bug Fixes

* **ci-babysitter:** escalate when CI never settles ([#52](https://github.com/NilsR0711/drydock/issues/52)) ([#70](https://github.com/NilsR0711/drydock/issues/70)) ([8227940](https://github.com/NilsR0711/drydock/commit/8227940ec2a46e93bb5f9640149601c351a782ac))
* **codex:** document intentional absence of a turn budget ([#48](https://github.com/NilsR0711/drydock/issues/48)) ([#66](https://github.com/NilsR0711/drydock/issues/66)) ([28aab3b](https://github.com/NilsR0711/drydock/commit/28aab3b2217a6f1c1eafd398130dc1a8f6f6d255))
* **log:** redact tokens in URLs, PRIVATE-TOKEN, Basic auth, cloud keys ([#69](https://github.com/NilsR0711/drydock/issues/69)) ([71673f2](https://github.com/NilsR0711/drydock/commit/71673f29c363f9bc0641892cd671a2484fe8a714)), closes [#51](https://github.com/NilsR0711/drydock/issues/51)
* **orchestrator:** decompose issues via the repo's agent provider ([#49](https://github.com/NilsR0711/drydock/issues/49)) ([#67](https://github.com/NilsR0711/drydock/issues/67)) ([7bfe049](https://github.com/NilsR0711/drydock/commit/7bfe049a2f8ad130d349a4d6463b35f7b5d7178e))
* **orchestrator:** reap orphaned worktrees on startup ([#53](https://github.com/NilsR0711/drydock/issues/53)) ([#71](https://github.com/NilsR0711/drydock/issues/71)) ([49c9f30](https://github.com/NilsR0711/drydock/commit/49c9f30b4b6e5b7d0ccb1446c2a4bc132300fa84))
* **orchestrator:** wall-clock timeout reclaims hung agent sessions ([#47](https://github.com/NilsR0711/drydock/issues/47)) ([#65](https://github.com/NilsR0711/drydock/issues/65)) ([4c6c636](https://github.com/NilsR0711/drydock/commit/4c6c63645414f86112282750038a71abb2e71e80))
* **run-job:** report a no-op run as a clear no-changes outcome ([#68](https://github.com/NilsR0711/drydock/issues/68)) ([116ea53](https://github.com/NilsR0711/drydock/commit/116ea53dc46a8aa20fa6c4ee5b89ff2de235789c))
* **stream:** never crash the process on a malformed agent stdout line ([#64](https://github.com/NilsR0711/drydock/issues/64)) ([fb32163](https://github.com/NilsR0711/drydock/commit/fb321639dd94fd4dbbf94b0e13222acc252d482a)), closes [#46](https://github.com/NilsR0711/drydock/issues/46)

## [0.1.1](https://github.com/NilsR0711/drydock/compare/v0.1.0...v0.1.1) (2026-05-28)

### Bug Fixes

* build the standalone bundle with webpack so `better-sqlite3` resolves in the published package ([#43](https://github.com/NilsR0711/drydock/pull/43))

## 0.1.0 (2026-05-28)

First release of **@nilsr0711/drydock** on npm.

### Features

* publish as an npm package startable from the terminal via `npx @nilsr0711/drydock` or, after a global install, `drydock`; the SQLite database is created and migrated automatically under `~/.drydock` on first start ([#40](https://github.com/NilsR0711/drydock/pull/40))
* `bin/drydock.mjs` launcher with `--port`, `--host`, `--open`, `--version`, `--help`, and a `drydock update` self-update command ([#40](https://github.com/NilsR0711/drydock/pull/40))
* self-contained Next.js standalone server bundle, published with provenance via a reusable GitHub Actions workflow ([#40](https://github.com/NilsR0711/drydock/pull/40), [#42](https://github.com/NilsR0711/drydock/pull/42))

# Changelog

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

# Changelog

## [1.2.1](https://github.com/NilsR0711/drydock/compare/v1.2.0...v1.2.1) (2026-07-14)


### Bug Fixes

* **deps:** release bundled production dependency updates ([#498](https://github.com/NilsR0711/drydock/issues/498)) ([e4807a5](https://github.com/NilsR0711/drydock/commit/e4807a5fac110749a695e7290217a13957fe00a8))

## [1.2.0](https://github.com/NilsR0711/drydock/compare/v1.1.1...v1.2.0) (2026-07-04)


### Features

* bulk requeue/abort on the needs-human screen ([#410](https://github.com/NilsR0711/drydock/issues/410)) ([d95c9d4](https://github.com/NilsR0711/drydock/commit/d95c9d40ca0b6ff833faa6abe4c47894fad2f326))
* **costs:** add monthly budget gate and month-end spend projection ([#413](https://github.com/NilsR0711/drydock/issues/413)) ([#468](https://github.com/NilsR0711/drydock/issues/468)) ([b730969](https://github.com/NilsR0711/drydock/commit/b730969c0e87f958f215e6a5e48da0b8b155a273))
* full-text search over job logs (cross-job + in the log viewer) ([#470](https://github.com/NilsR0711/drydock/issues/470)) ([6ce38ce](https://github.com/NilsR0711/drydock/commit/6ce38cebb624c1f31320c83364bb8fc5cdb08b07)), closes [#409](https://github.com/NilsR0711/drydock/issues/409)
* **jobs:** keep the job detail shell live on status transitions ([#456](https://github.com/NilsR0711/drydock/issues/456)) ([d64980a](https://github.com/NilsR0711/drydock/commit/d64980a3cc6cb2d8d2fde8266266614e012a3952)), closes [#398](https://github.com/NilsR0711/drydock/issues/398)
* **notify:** add a generic webhook notification channel ([#475](https://github.com/NilsR0711/drydock/issues/475)) ([1022b19](https://github.com/NilsR0711/drydock/commit/1022b19af3fd73703436d6a2fdad1eea09e5236f)), closes [#414](https://github.com/NilsR0711/drydock/issues/414)
* opt-out daily in-process DB backup sweep ([#467](https://github.com/NilsR0711/drydock/issues/467)) ([4105f2b](https://github.com/NilsR0711/drydock/commit/4105f2b9bc699e6f3c0298246ac3e4221b0572c8)), closes [#411](https://github.com/NilsR0711/drydock/issues/411)
* **orchestrator:** consolidate job memory into the parent project by default ([#375](https://github.com/NilsR0711/drydock/issues/375)) ([#440](https://github.com/NilsR0711/drydock/issues/440)) ([72b0556](https://github.com/NilsR0711/drydock/commit/72b0556ff1f1475765f0466f3336cc2c7503976c))
* **settings:** export/import the full instance configuration ([#412](https://github.com/NilsR0711/drydock/issues/412)) ([11ea167](https://github.com/NilsR0711/drydock/commit/11ea16775fe2f063f3d9f6b0e239a0dc9d01dcff))
* surface GitHub API rate-limit budget in /api/health and the dashboard ([#465](https://github.com/NilsR0711/drydock/issues/465)) ([fb394ab](https://github.com/NilsR0711/drydock/commit/fb394ab7d2ec1e637d1d155b3f900af81af087ce))


### Bug Fixes

* **a11y:** accessible names for issue modal and jobs filter controls ([#401](https://github.com/NilsR0711/drydock/issues/401)) ([#454](https://github.com/NilsR0711/drydock/issues/454)) ([4e54e5e](https://github.com/NilsR0711/drydock/commit/4e54e5efa7ee421fa0f6b680fdb46e8af3b55258))
* **a11y:** decouple aria-live announcements from the virtualized log list ([#460](https://github.com/NilsR0711/drydock/issues/460)) ([5d9be89](https://github.com/NilsR0711/drydock/commit/5d9be893e227c5d9cc3ca0d8129439ffc996e66d)), closes [#403](https://github.com/NilsR0711/drydock/issues/403)
* **a11y:** keep tooltips out of the a11y tree until open and keyboard-reachable ([#402](https://github.com/NilsR0711/drydock/issues/402)) ([#461](https://github.com/NilsR0711/drydock/issues/461)) ([c233ed0](https://github.com/NilsR0711/drydock/commit/c233ed058a909dc18399eecc1170aee773eb0d08))
* **a11y:** pause toast auto-dismiss on hover/focus and route links client-side ([#458](https://github.com/NilsR0711/drydock/issues/458)) ([5148762](https://github.com/NilsR0711/drydock/commit/5148762b8a7f0920dec91625872bc05a642a7c81)), closes [#405](https://github.com/NilsR0711/drydock/issues/405)
* **ci:** keep doc-review green on fork PRs ([#449](https://github.com/NilsR0711/drydock/issues/449)) ([ad55b0d](https://github.com/NilsR0711/drydock/commit/ad55b0d213f6b244ec5865efd8f5386f9e9826ae)), closes [#392](https://github.com/NilsR0711/drydock/issues/392)
* **ci:** publish on release-PR merge instead of a second manual dispatch ([#452](https://github.com/NilsR0711/drydock/issues/452)) ([d9866fb](https://github.com/NilsR0711/drydock/commit/d9866fbb13882f153c52efba47b92ab209e5a02c)), closes [#394](https://github.com/NilsR0711/drydock/issues/394)
* **dashboard:** re-alert re-parked needs_human jobs after requeue ([#455](https://github.com/NilsR0711/drydock/issues/455)) ([ee3ba15](https://github.com/NilsR0711/drydock/commit/ee3ba159f05f3c892425738c675e32bb8ba2a8d5)), closes [#406](https://github.com/NilsR0711/drydock/issues/406)
* **db:** cascade-delete followup_issues with their job ([#418](https://github.com/NilsR0711/drydock/issues/418)) ([#474](https://github.com/NilsR0711/drydock/issues/474)) ([7477872](https://github.com/NilsR0711/drydock/commit/74778727f96ce4966299807663c223db4e827ae3))
* **db:** diagnose pre-existing FK corruption instead of blaming the next migration ([#471](https://github.com/NilsR0711/drydock/issues/471)) ([3267071](https://github.com/NilsR0711/drydock/commit/3267071b1fa0076c3ca10be43d4ed798d9838e19)), closes [#417](https://github.com/NilsR0711/drydock/issues/417)
* degrade corrupt job-event payloads instead of bricking detail pages ([#473](https://github.com/NilsR0711/drydock/issues/473)) ([6e5edae](https://github.com/NilsR0711/drydock/commit/6e5edae9c2df1dd79e24a1b790c50ee8b57ae8ba)), closes [#419](https://github.com/NilsR0711/drydock/issues/419)
* **deploy-heal:** log getLogs failures instead of silently swallowing them ([#476](https://github.com/NilsR0711/drydock/issues/476)) ([361510d](https://github.com/NilsR0711/drydock/commit/361510d5e21d40b02b6a85b9f29a3b4324e90717)), closes [#423](https://github.com/NilsR0711/drydock/issues/423)
* **deps:** bump hono to 4.12.27 to clear HIGH CORS advisory ([#477](https://github.com/NilsR0711/drydock/issues/477)) ([fa27ce0](https://github.com/NilsR0711/drydock/commit/fa27ce047333892d690583c2a1ff6be645cabe76)), closes [#426](https://github.com/NilsR0711/drydock/issues/426)
* **deps:** override monaco's pinned dompurify to a patched release ([#428](https://github.com/NilsR0711/drydock/issues/428)) ([#484](https://github.com/NilsR0711/drydock/issues/484)) ([bc9a899](https://github.com/NilsR0711/drydock/commit/bc9a899bffa9a4aeded73dfc0d716828840ae191))
* **deps:** remove unused prod dependencies zustand and nuqs ([#478](https://github.com/NilsR0711/drydock/issues/478)) ([4569738](https://github.com/NilsR0711/drydock/commit/45697382bb35e22f0931594e957fa6178426cf44)), closes [#427](https://github.com/NilsR0711/drydock/issues/427)
* **orchestrator:** bound review-feedback and deployment-healing side sessions ([#383](https://github.com/NilsR0711/drydock/issues/383)) ([#439](https://github.com/NilsR0711/drydock/issues/439)) ([2edebc7](https://github.com/NilsR0711/drydock/commit/2edebc7f1b187361893af3538b0cb5bc7f815911))
* **orchestrator:** clear stale finishedAt/errorMessage on requeue ([#434](https://github.com/NilsR0711/drydock/issues/434)) ([87a5b03](https://github.com/NilsR0711/drydock/commit/87a5b0301ce9eda76b623b50f9e9ccd18fe3dc37)), closes [#381](https://github.com/NilsR0711/drydock/issues/381)
* **orchestrator:** don't record an unpushed branch on questions-only park ([#433](https://github.com/NilsR0711/drydock/issues/433)) ([5e54ab1](https://github.com/NilsR0711/drydock/commit/5e54ab1c82dd5dce3a7db310ca5a6baac442037c)), closes [#380](https://github.com/NilsR0711/drydock/issues/380)
* **orchestrator:** force-with-lease the fresh-cut push so a requeue supersedes its stale remote branch ([#436](https://github.com/NilsR0711/drydock/issues/436)) ([dacaf59](https://github.com/NilsR0711/drydock/commit/dacaf59baf4991485d16ac80b30aafd66cf16359)), closes [#378](https://github.com/NilsR0711/drydock/issues/378)
* **orchestrator:** guard fire-and-forget edge notifications in the driver loop ([#483](https://github.com/NilsR0711/drydock/issues/483)) ([55639d4](https://github.com/NilsR0711/drydock/commit/55639d44f8d7eebacc5e2195369925a98fb94aed)), closes [#420](https://github.com/NilsR0711/drydock/issues/420)
* **orchestrator:** guard the babysitter merge against silent queue and failure ([#386](https://github.com/NilsR0711/drydock/issues/386)) ([#446](https://github.com/NilsR0711/drydock/issues/446)) ([b500028](https://github.com/NilsR0711/drydock/commit/b500028ddb6c20fcce261675201bc85164804c04))
* **orchestrator:** hold a set of abort handles per job so overlapping sessions stay killable ([#384](https://github.com/NilsR0711/drydock/issues/384)) ([#438](https://github.com/NilsR0711/drydock/issues/438)) ([034e3a3](https://github.com/NilsR0711/drydock/commit/034e3a355074cc7d7b50553b8856667cac001709))
* **orchestrator:** share in-memory singletons across Next.js bundle layers ([#379](https://github.com/NilsR0711/drydock/issues/379)) ([891c02b](https://github.com/NilsR0711/drydock/commit/891c02b3ef316a2b48803e60579358d7ea31b925))
* **orchestrator:** unify the five one-shot generator wrappers and restore provider-limit latching ([#487](https://github.com/NilsR0711/drydock/issues/487)) ([8f3bf54](https://github.com/NilsR0711/drydock/commit/8f3bf546db10ebd53d14940231b72b3a8d812655))
* **prompts:** serve Monaco from the bundle instead of the jsdelivr CDN ([#486](https://github.com/NilsR0711/drydock/issues/486)) ([ff02f8d](https://github.com/NilsR0711/drydock/commit/ff02f8d257ea29b647303d0e1f788044522906f2)), closes [#429](https://github.com/NilsR0711/drydock/issues/429)
* **prune:** skip the scheduled VACUUM when nothing was deleted ([#472](https://github.com/NilsR0711/drydock/issues/472)) ([d200ff5](https://github.com/NilsR0711/drydock/commit/d200ff5e5c1a98dfd27edd31e8e0492854bb57fa)), closes [#416](https://github.com/NilsR0711/drydock/issues/416)
* **release:** surface the real reason when release evaluation fails ([#482](https://github.com/NilsR0711/drydock/issues/482)) ([09454cc](https://github.com/NilsR0711/drydock/commit/09454cc9b3e47f14e3865a97b8bf703c364fdb08)), closes [#424](https://github.com/NilsR0711/drydock/issues/424)
* **security:** guard API GET routes against DNS-rebinding ([#435](https://github.com/NilsR0711/drydock/issues/435)) ([6d7b865](https://github.com/NilsR0711/drydock/commit/6d7b86576c037f696f76fe69a04edee259349880))
* **settings:** recover a corrupt global settings row instead of silently wiping it ([#481](https://github.com/NilsR0711/drydock/issues/481)) ([6770311](https://github.com/NilsR0711/drydock/commit/67703114ff302e4266d99784bc26dcd9956ccc6e)), closes [#421](https://github.com/NilsR0711/drydock/issues/421)
* **subtasks:** log decompose one-shot failures instead of silently returning [] ([#480](https://github.com/NilsR0711/drydock/issues/480)) ([994cae3](https://github.com/NilsR0711/drydock/commit/994cae3fc4f44dcc816a61efa720934f98fa4ec9)), closes [#422](https://github.com/NilsR0711/drydock/issues/422)
* **ui:** expose SegmentedControl and log-viewer filter toggle state via ARIA ([#457](https://github.com/NilsR0711/drydock/issues/457)) ([92c6be3](https://github.com/NilsR0711/drydock/commit/92c6be3369057fc7d4e99611231addfddfd51bc7)), closes [#400](https://github.com/NilsR0711/drydock/issues/400)
* **ui:** guard IssueDetailModal against stale issue-detail responses ([#453](https://github.com/NilsR0711/drydock/issues/453)) ([60fafd6](https://github.com/NilsR0711/drydock/commit/60fafd66bac3cecd2f8a334bf4e12506b57b5afc)), closes [#399](https://github.com/NilsR0711/drydock/issues/399)
* **ui:** lock scroll and inert the background while a Dialog is open ([#462](https://github.com/NilsR0711/drydock/issues/462)) ([62779e6](https://github.com/NilsR0711/drydock/commit/62779e6eab8a679b1fa20fb9b316df1cd7fe2de8)), closes [#404](https://github.com/NilsR0711/drydock/issues/404)
* **ui:** surface subtask read failures in the issue detail modal ([#425](https://github.com/NilsR0711/drydock/issues/425)) ([#479](https://github.com/NilsR0711/drydock/issues/479)) ([ba06b87](https://github.com/NilsR0711/drydock/commit/ba06b87a3c33eb3b0f51502caee2ecdb00948225))


### Performance Improvements

* **dashboard:** aggregate SSE snapshot in SQL and share it across clients ([#415](https://github.com/NilsR0711/drydock/issues/415)) ([c55afe7](https://github.com/NilsR0711/drydock/commit/c55afe76110221501bbdcebc0c937e982270e333))

## [1.1.1](https://github.com/NilsR0711/drydock/compare/v1.1.0...v1.1.1) (2026-06-23)


### Bug Fixes

* **deps:** ship updated production dependencies in the published bundle ([#373](https://github.com/NilsR0711/drydock/issues/373)) ([d578a6c](https://github.com/NilsR0711/drydock/commit/d578a6c824ba250ac00448ee03d60186422eb4b6))

## [1.1.0](https://github.com/NilsR0711/drydock/compare/v1.0.1...v1.1.0) (2026-06-20)


### Features

* **agents:** add opencode as a third CLI agent ([#354](https://github.com/NilsR0711/drydock/issues/354)) ([042073d](https://github.com/NilsR0711/drydock/commit/042073d80252a1d909a2973a40fd5befea3daafb))
* **agents:** give codex a permission-bypass flag for full shell access ([#353](https://github.com/NilsR0711/drydock/issues/353)) ([1d57c38](https://github.com/NilsR0711/drydock/commit/1d57c388b7cf1b9659bc973522d306c9b46981d5))
* **agents:** map opencode autonomous permission bypass so headless jobs don't hang ([#350](https://github.com/NilsR0711/drydock/issues/350)) ([#363](https://github.com/NilsR0711/drydock/issues/363)) ([60ec23f](https://github.com/NilsR0711/drydock/commit/60ec23fdaa231606c186bbfc8e9bfd029d53b342))
* **agents:** retire the custom OpenRouter backend for opencode ([#362](https://github.com/NilsR0711/drydock/issues/362)) ([58ed259](https://github.com/NilsR0711/drydock/commit/58ed2591d84e99a9bb107de8d7bb07b99fd73938))
* **ci:** drop EOL Node 20, test against current LTS (22 + 24) ([#358](https://github.com/NilsR0711/drydock/issues/358)) ([f451e18](https://github.com/NilsR0711/drydock/commit/f451e18d4a4141fd61f425c3d2f1c2566b1039cc))
* export/import repo settings as a portable bundle ([#348](https://github.com/NilsR0711/drydock/issues/348)) ([#351](https://github.com/NilsR0711/drydock/issues/351)) ([ffcf5aa](https://github.com/NilsR0711/drydock/commit/ffcf5aa2b8bc2af3880659a3161d98b64fe09228))
* **onboarding:** first-run setup checklist for agent CLIs, forge clients & environment ([#356](https://github.com/NilsR0711/drydock/issues/356)) ([#360](https://github.com/NilsR0711/drydock/issues/360)) ([513dc77](https://github.com/NilsR0711/drydock/commit/513dc77e2af8faf1395136aeda2787283611458b))
* **release:** prominent "Create release" button + per-repo release playbook memoization ([#352](https://github.com/NilsR0711/drydock/issues/352)) ([985f80b](https://github.com/NilsR0711/drydock/commit/985f80b7ec7bc1bcf7636e97560f6ab10c4479ae))


### Bug Fixes

* **driver-loop:** tick watchdog so a hung tick never wedges the loop ([#359](https://github.com/NilsR0711/drydock/issues/359)) ([4235341](https://github.com/NilsR0711/drydock/commit/4235341b16ffd0b2bc4c4801a8dee289b76520e1))
* **jobs:** stable id tiebreaker for job history ordering ([#347](https://github.com/NilsR0711/drydock/issues/347)) ([0cf1233](https://github.com/NilsR0711/drydock/commit/0cf1233955b0989987617f7f09badb92c1aa8d15)), closes [#346](https://github.com/NilsR0711/drydock/issues/346)

## [1.0.1](https://github.com/NilsR0711/drydock/compare/v1.0.0...v1.0.1) (2026-06-20)


### Bug Fixes

* **worktree:** branch jobs off origin's default, not the stale local ref ([#343](https://github.com/NilsR0711/drydock/issues/343)) ([90c6817](https://github.com/NilsR0711/drydock/commit/90c681746ec0abe3cec231af2cf5899043d202ed)), closes [#341](https://github.com/NilsR0711/drydock/issues/341)

## [1.0.0](https://github.com/NilsR0711/drydock/compare/v0.1.13...v1.0.0) (2026-06-20)


### Bug Fixes

* **job-detail:** live status badge, Stop button & duration timer ([#337](https://github.com/NilsR0711/drydock/issues/337)) ([745e782](https://github.com/NilsR0711/drydock/commit/745e7826b4bc7d4ce6ac17973b3b134498a84983))


### Build System

* **release-please:** graduate to stable, cut v1.0.0 ([#339](https://github.com/NilsR0711/drydock/issues/339)) ([8413ff3](https://github.com/NilsR0711/drydock/commit/8413ff39fd5a79a91ddc85b166fb26674de23208))

## [0.1.13](https://github.com/NilsR0711/drydock/compare/v0.1.12...v0.1.13) (2026-06-19)


### Features

* **branch-janitor:** agent-based merge-conflict resolution, opt-in ([#327](https://github.com/NilsR0711/drydock/issues/327)) ([aff0db8](https://github.com/NilsR0711/drydock/commit/aff0db8b7e173dd21edb05c0a0d8e00eb985e49a))
* **repos:** per-repo command allowlist (--allowedTools) for headless git/xcodebuild/simctl ([#329](https://github.com/NilsR0711/drydock/issues/329)) ([#335](https://github.com/NilsR0711/drydock/issues/335)) ([ce1875a](https://github.com/NilsR0711/drydock/commit/ce1875a9f4cb7f1c02785a014b4c78b0cea65eb6))


### Bug Fixes

* **orchestrator:** reuse the existing PR on resume instead of re-running createPr ([#331](https://github.com/NilsR0711/drydock/issues/331)) ([#334](https://github.com/NilsR0711/drydock/issues/334)) ([5bb07b2](https://github.com/NilsR0711/drydock/commit/5bb07b22dd933f8cfc91f8ff5895c818cad2d2be))
* **review-feedback:** forward repo.bypassPermissions to the side session ([#333](https://github.com/NilsR0711/drydock/issues/333)) ([93d4d19](https://github.com/NilsR0711/drydock/commit/93d4d19c0cadb736e87e0aee00016f4ff5102e82)), closes [#328](https://github.com/NilsR0711/drydock/issues/328)
* **review-feedback:** share the sweep chain across bundle layers ([#326](https://github.com/NilsR0711/drydock/issues/326)) ([#330](https://github.com/NilsR0711/drydock/issues/330)) ([827bf5e](https://github.com/NilsR0711/drydock/commit/827bf5eb194bc267914fad66734c13eaf0ab5def))

## [0.1.12](https://github.com/NilsR0711/drydock/compare/v0.1.11...v0.1.12) (2026-06-19)


### Features

* **pr-audit:** auto-fix the audit's own findings (opt-in) ([#323](https://github.com/NilsR0711/drydock/issues/323)) ([4fbc2e5](https://github.com/NilsR0711/drydock/commit/4fbc2e5758559bb17c79b051a8bd1c4bfcdcd5cb))
* **pr-audit:** post the PR audit on the pull request, not the issue ([#317](https://github.com/NilsR0711/drydock/issues/317)) ([#322](https://github.com/NilsR0711/drydock/issues/322)) ([04f7b16](https://github.com/NilsR0711/drydock/commit/04f7b1673e5def2e51eeb0b5df4b844fba0b55b2))
* **repos:** make AI PR audit opt-in (default off) ([#321](https://github.com/NilsR0711/drydock/issues/321)) ([7187bdc](https://github.com/NilsR0711/drydock/commit/7187bdc0a7bd04bcdeb6376e23280fa2af51fc7e))


### Bug Fixes

* **review-feedback:** force-add the apply worktree so it can share a branch the job worktree still holds ([#319](https://github.com/NilsR0711/drydock/issues/319)) ([#320](https://github.com/NilsR0711/drydock/issues/320)) ([6c6a5e6](https://github.com/NilsR0711/drydock/commit/6c6a5e698429696fd1edc45977b811a31cfa3a91))

## [0.1.11](https://github.com/NilsR0711/drydock/compare/v0.1.10...v0.1.11) (2026-06-19)


### Bug Fixes

* **issues:** X (remove from queue) aborts a not-yet-started job so the issue leaves the queue zone ([#312](https://github.com/NilsR0711/drydock/issues/312)) ([8f39750](https://github.com/NilsR0711/drydock/commit/8f39750d05da80dd5e827e02b50de344f6f8e8b4))
* **review-feedback:** never post status replies into a bot's review thread ([#313](https://github.com/NilsR0711/drydock/issues/313)) ([5048b4e](https://github.com/NilsR0711/drydock/commit/5048b4e6bd5519187c8d9a9c9013d18983fc5b01))

## [0.1.10](https://github.com/NilsR0711/drydock/compare/v0.1.9...v0.1.10) (2026-06-19)


### Features

* babysit arbitrary PRs added by URL ([#293](https://github.com/NilsR0711/drydock/issues/293)) ([#309](https://github.com/NilsR0711/drydock/issues/309)) ([6e9ff13](https://github.com/NilsR0711/drydock/commit/6e9ff13bf3311cafa04a01872743b96b997bb181))
* expose PR Q&A over MCP/API (ask_pr_question tool) ([#296](https://github.com/NilsR0711/drydock/issues/296)) ([fc9794e](https://github.com/NilsR0711/drydock/commit/fc9794e374735ac58fd22c4c8cd813fa59deefe4))
* global server logs page (filter, search, live tail, retention) ([#306](https://github.com/NilsR0711/drydock/issues/306)) ([bd88504](https://github.com/NilsR0711/drydock/commit/bd88504c85119980dd71e47a18e65cea4315e1e8)), closes [#294](https://github.com/NilsR0711/drydock/issues/294)
* **jobs:** live-update the job history page ([#282](https://github.com/NilsR0711/drydock/issues/282)) ([#290](https://github.com/NilsR0711/drydock/issues/290)) ([91d6b27](https://github.com/NilsR0711/drydock/commit/91d6b27c4a2fca084b277b982202721214c7b07c))
* native macOS menu-bar shell (Tauri) + HTTP control endpoints ([#308](https://github.com/NilsR0711/drydock/issues/308)) ([4773b52](https://github.com/NilsR0711/drydock/commit/4773b52d60ebcf1ab35f864f3fbe7be42207eb0b))
* **repos:** per-repo toggle to run agent jobs with --dangerously-skip-permissions ([#297](https://github.com/NilsR0711/drydock/issues/297)) ([a3759d6](https://github.com/NilsR0711/drydock/commit/a3759d66326c91ef4de63719e898477d2d4f54b4)), closes [#283](https://github.com/NilsR0711/drydock/issues/283)


### Bug Fixes

* **fs:** stat resolved realpath to close symlink TOCTOU in directory browse ([#303](https://github.com/NilsR0711/drydock/issues/303)) ([24e7bae](https://github.com/NilsR0711/drydock/commit/24e7baec19a3563c0b706ab295f29fd063e94f38))
* **orchestrator:** auto-resolve-merge-conflicts flag is a no-op; conflicted PRs always park instead of auto-rebasing ([#298](https://github.com/NilsR0711/drydock/issues/298)) ([3728800](https://github.com/NilsR0711/drydock/commit/3728800db3923f75560f7fb005529b45ed1e3a7c))
* **orchestrator:** decouple issue decomposition from the driver tick critical path ([#284](https://github.com/NilsR0711/drydock/issues/284)) ([#299](https://github.com/NilsR0711/drydock/issues/299)) ([edc843f](https://github.com/NilsR0711/drydock/commit/edc843f100738e75556ff519210b3fbae5805fc1))
* **orchestrator:** don't re-enqueue an already-merged/closed issue ([#288](https://github.com/NilsR0711/drydock/issues/288)) ([cf224f3](https://github.com/NilsR0711/drydock/commit/cf224f323bbfebaefa5e0e783ad4047dcdd0345d))
* **repos:** default auto-triage/process/decompose OFF (opt-in) ([#307](https://github.com/NilsR0711/drydock/issues/307)) ([2c983ba](https://github.com/NilsR0711/drydock/commit/2c983ba1c7c3b0e528c31b8c3e0c4cd0622335d9)), closes [#285](https://github.com/NilsR0711/drydock/issues/285)
* **ui:** issue board Queue reflects scheduler state, not just the queue label ([#304](https://github.com/NilsR0711/drydock/issues/304)) ([bd61080](https://github.com/NilsR0711/drydock/commit/bd61080f19fe4e2c09c791c0446dce75d3c02e14)), closes [#286](https://github.com/NilsR0711/drydock/issues/286)
* **ux:** consolidate Drydock lifecycle comments via shared marker upsert ([#289](https://github.com/NilsR0711/drydock/issues/289)) ([#302](https://github.com/NilsR0711/drydock/issues/302)) ([6c73bc8](https://github.com/NilsR0711/drydock/commit/6c73bc829268cdac164a64bdee2c4c1ebccc7529))

## [0.1.9](https://github.com/NilsR0711/drydock/compare/v0.1.8...v0.1.9) (2026-06-19)


### Features

* human-readable job titles and branch names (issue title slug) ([#280](https://github.com/NilsR0711/drydock/issues/280)) ([3b17c94](https://github.com/NilsR0711/drydock/commit/3b17c94a49ae3db3f46a363da0d621a1c992ea9d)), closes [#278](https://github.com/NilsR0711/drydock/issues/278)
* **orchestrator:** detect max-turns abort and auto-resume instead of generic 'exited non-zero' ([#277](https://github.com/NilsR0711/drydock/issues/277)) ([00ed36e](https://github.com/NilsR0711/drydock/commit/00ed36ee3d063acb74bf2e29479b25ed0d0b8b5d))
* **repos:** opt-in claude-mem worktree adoption after merge (per-repo setting) ([#275](https://github.com/NilsR0711/drydock/issues/275)) ([5e44b81](https://github.com/NilsR0711/drydock/commit/5e44b81ed84ed59acdcfc416ee5eee9d2959bbba))
* **turns:** default the per-job turn budget to unlimited (0) ([#276](https://github.com/NilsR0711/drydock/issues/276)) ([1b98810](https://github.com/NilsR0711/drydock/commit/1b98810eb282c1722c29dc6064596ee393d43241))


### Bug Fixes

* **orchestrator:** share abort registry on globalThis so Stop kills the agent ([#273](https://github.com/NilsR0711/drydock/issues/273)) ([bf7e793](https://github.com/NilsR0711/drydock/commit/bf7e79371c50b7807902ef36518e742966730248))

## [0.1.8](https://github.com/NilsR0711/drydock/compare/v0.1.7...v0.1.8) (2026-06-18)


### Features

* agent auto-files follow-up issues via .drydock/FOLLOWUPS.md ([#264](https://github.com/NilsR0711/drydock/issues/264)) ([b7fa515](https://github.com/NilsR0711/drydock/commit/b7fa515141376fe2ccde1502b3f52fe00119b80a))
* alert with sound + notification when a job needs a human ([#258](https://github.com/NilsR0711/drydock/issues/258)) ([59a6f8f](https://github.com/NilsR0711/drydock/commit/59a6f8f1da76c1063d1cacba35218b6c45d185ba))
* autonomous needs_human handoff via .drydock/QUESTIONS.md ([#251](https://github.com/NilsR0711/drydock/issues/251)) ([a0132f8](https://github.com/NilsR0711/drydock/commit/a0132f87a8dabbecf4a78c19948e0c2d4c9685bc))
* **cost:** make cost budgets turn-off-able and consistent (0 = unlimited) ([#234](https://github.com/NilsR0711/drydock/issues/234)) ([#239](https://github.com/NilsR0711/drydock/issues/239)) ([470406d](https://github.com/NilsR0711/drydock/commit/470406d463cc16f339dcff53e90e77dfb43ad412))
* **job-detail:** tick Duration live and refresh metrics from the stream ([#247](https://github.com/NilsR0711/drydock/issues/247)) ([3ccd3a0](https://github.com/NilsR0711/drydock/commit/3ccd3a0a52dc91a487b03ac767ad29a97e7da23a)), closes [#242](https://github.com/NilsR0711/drydock/issues/242)
* **log-viewer:** show newest job events at the top ([#243](https://github.com/NilsR0711/drydock/issues/243)) ([#245](https://github.com/NilsR0711/drydock/issues/245)) ([be7897b](https://github.com/NilsR0711/drydock/commit/be7897b8647602a486db2e5bef3e7f665ca88c05))
* make 'fully autonomous' the default (all auto-flags on, no cost/turn ceilings) ([#271](https://github.com/NilsR0711/drydock/issues/271)) ([cf4f9c4](https://github.com/NilsR0711/drydock/commit/cf4f9c444ef9799f31d927166504bcb52ecdf3e8))
* manual agent-driven release button ([#256](https://github.com/NilsR0711/drydock/issues/256)) ([507e47a](https://github.com/NilsR0711/drydock/commit/507e47ab1d432bb3a26987a411519afae424aff4))
* **mcp:** ship the stdio MCP server in the npm distribution ([#230](https://github.com/NilsR0711/drydock/issues/230)) ([#238](https://github.com/NilsR0711/drydock/issues/238)) ([4740f0d](https://github.com/NilsR0711/drydock/commit/4740f0dad8a3f535f553001d5bd99cde69d134ba))
* **needs-human:** resume a parked job with typed instructions on its branch ([#257](https://github.com/NilsR0711/drydock/issues/257)) ([#266](https://github.com/NilsR0711/drydock/issues/266)) ([c1e958f](https://github.com/NilsR0711/drydock/commit/c1e958f04a2d51a3644885538ba583ebde33ed10))
* **orchestrator:** make needs_human visible on the GitHub issue ([#250](https://github.com/NilsR0711/drydock/issues/250)) ([#263](https://github.com/NilsR0711/drydock/issues/263)) ([b72df56](https://github.com/NilsR0711/drydock/commit/b72df561229f745da332e3ccd4bbbe697f762513))
* preserve branch + commits when a job parks in needs_human ([#249](https://github.com/NilsR0711/drydock/issues/249)) ([#262](https://github.com/NilsR0711/drydock/issues/262)) ([a278274](https://github.com/NilsR0711/drydock/commit/a278274b18228108e1e0c04bb6fc895d00920c7c))
* **prompts:** make the PR body format a per-repo editable template ([#252](https://github.com/NilsR0711/drydock/issues/252)) ([#253](https://github.com/NilsR0711/drydock/issues/253)) ([4166f95](https://github.com/NilsR0711/drydock/commit/4166f95e16019dd5b2ec9c26193a06d819868866))
* **prompts:** rewrite default agent prompts to best-in-class (TDD, docs-aware, verify-before-finish) ([#268](https://github.com/NilsR0711/drydock/issues/268)) ([0afa998](https://github.com/NilsR0711/drydock/commit/0afa998f1ba14c5120e4448021e36ef53cb718c3))
* thematic commits and no AI attribution on worked branches ([#259](https://github.com/NilsR0711/drydock/issues/259)) ([8d7fe71](https://github.com/NilsR0711/drydock/commit/8d7fe7154026f51e14e074fc2fadb32829f2c47d))


### Bug Fixes

* **dashboard:** live-update repo list/count after adding a repo ([#232](https://github.com/NilsR0711/drydock/issues/232)) ([#237](https://github.com/NilsR0711/drydock/issues/237)) ([f374812](https://github.com/NilsR0711/drydock/commit/f3748122c3a7cc8c849cf42d4044ee3abc0dba34))
* **driver:** stop silently dropping manually queued review-pattern issues ([#240](https://github.com/NilsR0711/drydock/issues/240)) ([#244](https://github.com/NilsR0711/drydock/issues/244)) ([3e8be17](https://github.com/NilsR0711/drydock/commit/3e8be17cf8ae897c898efead9918a9b36d134abd))
* **exec:** wire agent stdin to /dev/null to silence benign CLI warning ([#236](https://github.com/NilsR0711/drydock/issues/236)) ([39e5cda](https://github.com/NilsR0711/drydock/commit/39e5cda3bed83e4732ebfb6c5c9863fd00355125)), closes [#233](https://github.com/NilsR0711/drydock/issues/233)
* **git:** guard against empty commit message after stripping AI attribution ([#270](https://github.com/NilsR0711/drydock/issues/270)) ([e3ce3e3](https://github.com/NilsR0711/drydock/commit/e3ce3e38955cb6d70f0b5dbdca17898049bc19d0)), closes [#269](https://github.com/NilsR0711/drydock/issues/269)
* **health:** report driver.lockHeld per-process, not lock-exists ([#235](https://github.com/NilsR0711/drydock/issues/235)) ([3949c78](https://github.com/NilsR0711/drydock/commit/3949c787ca3cc72fe3efb665d03eba8c9f1f59ff)), closes [#231](https://github.com/NilsR0711/drydock/issues/231)
* **log-viewer:** live log stream never updates for Claude jobs ([#241](https://github.com/NilsR0711/drydock/issues/241)) ([c888e62](https://github.com/NilsR0711/drydock/commit/c888e624b088d5dc8158cc07753aa096aabebfc0))

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

# Changelog

## [0.13.0](https://github.com/swoofer/essaim/compare/v0.12.1...v0.13.0) (2026-08-27)


### Features

* **agent-loop:** les agents savent enfin sur quoi ils travaillent, et le run devient ventilable ([#131](https://github.com/swoofer/essaim/issues/131)) ([97011ad](https://github.com/swoofer/essaim/commit/97011add38c77aeb50328ea062a8d168e9041141))

## [0.12.1](https://github.com/swoofer/essaim/compare/v0.12.0...v0.12.1) (2026-08-26)


### Bug Fixes

* **release:** la compilation Windows échouait et emportait darwin-arm64 ([#129](https://github.com/swoofer/essaim/issues/129)) ([a5fab7d](https://github.com/swoofer/essaim/commit/a5fab7d41f3f64e5381a23695bb336a8efef4c15))

## [0.12.0](https://github.com/swoofer/essaim/compare/v0.11.0...v0.12.0) (2026-08-26)


### Features

* **release:** binaire Windows, et la version cesse de répondre 0.0.0 ([#126](https://github.com/swoofer/essaim/issues/126)) ([de4f90a](https://github.com/swoofer/essaim/commit/de4f90aa10b0673c4872f9328ecc784960ac406e))


### Bug Fixes

* **falsifiability:** la commande de test codée en dur défaisait le garde-fou ([#127](https://github.com/swoofer/essaim/issues/127)) ([c7dd9b8](https://github.com/swoofer/essaim/commit/c7dd9b8b276e1c3168049fe76ea2c45b0eb37d9e))

## [0.11.0](https://github.com/swoofer/essaim/compare/v0.10.0...v0.11.0) (2026-08-26)


### Features

* **agent-loop:** un DONE: n'est plus accepté sans test qui échoue (opt-in) ([#124](https://github.com/swoofer/essaim/issues/124)) ([dd70f0a](https://github.com/swoofer/essaim/commit/dd70f0a0b268a9156a5c1e7aa3b88cab5a580791))


### Bug Fixes

* **coordination:** le plan révisé d'un ADJUST atteint enfin les pairs ([#108](https://github.com/swoofer/essaim/issues/108)) ([#120](https://github.com/swoofer/essaim/issues/120)) ([53ceee5](https://github.com/swoofer/essaim/commit/53ceee5fb73fd65c2a316879cdbd30f69457cbc8))
* **falsifiability:** git repliait les fichiers non suivis, le garde-fou passait à côté ([#125](https://github.com/swoofer/essaim/issues/125)) ([48407eb](https://github.com/swoofer/essaim/commit/48407eba877a3b690ffa6aeac5ddcf085b2f9514))
* **orchestrator:** vise 127.0.0.1, pas localhost — le coordinator n'écoute pas en IPv6 ([#122](https://github.com/swoofer/essaim/issues/122)) ([13b5044](https://github.com/swoofer/essaim/commit/13b50449081b7a7fc29a529290fe613c5da3c701))
* **work-stealing:** rend les abandons diagnosticables et moins mécaniques ([#123](https://github.com/swoofer/essaim/issues/123)) ([533d4a5](https://github.com/swoofer/essaim/commit/533d4a5bb6b7af61dd1db96f285e398aecc4861f))

## [0.10.0](https://github.com/swoofer/essaim/compare/v0.9.0...v0.10.0) (2026-08-24)


### Features

* **coordinator:** migration vers mcp-coordinator 2.2.1 ([#117](https://github.com/swoofer/essaim/issues/117)) ([57f3b23](https://github.com/swoofer/essaim/commit/57f3b23ad48f5afafb6cac9342951b8072513aa0))


### Bug Fixes

* **agent-loop:** libère les tâches réclamées au CLEANUP ([#101](https://github.com/swoofer/essaim/issues/101)) ([#111](https://github.com/swoofer/essaim/issues/111)) ([bbd237d](https://github.com/swoofer/essaim/commit/bbd237dcc9bef295db7cb37932cef6e34dd1ef46))
* **catalog:** swarm.yaml double-encodé + compteurs de doc périmés ([#114](https://github.com/swoofer/essaim/issues/114)) ([600d271](https://github.com/swoofer/essaim/commit/600d271940469a5849421387d69eefa5d08f3e6d))
* **hooks:** normalisation de chemin cassée sous Git Bash, et tests shell branchés ([#100](https://github.com/swoofer/essaim/issues/100)) ([#113](https://github.com/swoofer/essaim/issues/113)) ([4fe534c](https://github.com/swoofer/essaim/commit/4fe534c81f72fb2a671317340e2941d825837f49))
* **mqtt:** le catch-up lisait deux colonnes que le coordinator n'expose pas ([#98](https://github.com/swoofer/essaim/issues/98)) ([#110](https://github.com/swoofer/essaim/issues/110)) ([80b7c17](https://github.com/swoofer/essaim/commit/80b7c17e502a0d50f7ee27163830aff822445286))
* **orchestrator:** trois défauts de robustesse au lancement ([#96](https://github.com/swoofer/essaim/issues/96), [#97](https://github.com/swoofer/essaim/issues/97)) ([#109](https://github.com/swoofer/essaim/issues/109)) ([faa70e6](https://github.com/swoofer/essaim/commit/faa70e6df61fd36b3381eb5b6e9b4ac8e4e51c19))
* **pipeline:** refuse les formes qui se chargeaient en silence ([#99](https://github.com/swoofer/essaim/issues/99)) ([#112](https://github.com/swoofer/essaim/issues/112)) ([5501b64](https://github.com/swoofer/essaim/commit/5501b64f6253d08156ea912cb5df992ab55b2fe3))


### Documentation

* remet la roadmap, les compteurs et la version affichée au niveau de la 0.9.0 ([#115](https://github.com/swoofer/essaim/issues/115)) ([7c1c36b](https://github.com/swoofer/essaim/commit/7c1c36b921fefd5f60aeaed6b991970458822b87))
* **site:** remet le registry de presets et l'intégration IDE dans la v51 ([#116](https://github.com/swoofer/essaim/issues/116)) ([57c37d4](https://github.com/swoofer/essaim/commit/57c37d450367f2774fa5462cff5c40e4f8676c59))
* **site:** retire les documents de travail superpowers de la publication ([#105](https://github.com/swoofer/essaim/issues/105)) ([0124d71](https://github.com/swoofer/essaim/commit/0124d710bb8f0a3043e5fc1dc4fdd26ac4836189))

## [0.9.0](https://github.com/swoofer/essaim/compare/v0.8.1...v0.9.0) (2026-08-14)


### ⚠ BREAKING CHANGES

* **workspace:** ESSAIM_RESET_BASE=1 n'autorise plus rien. La variable doit désormais contenir le chemin du répertoire à réinitialiser, et ce chemin doit correspondre à la base du run. Le message d'erreur donne la valeur à utiliser.

### Bug Fixes

* **coordination:** une seule décision LLM par round ([#53](https://github.com/swoofer/essaim/issues/53)) ([#95](https://github.com/swoofer/essaim/issues/95)) ([4cc059d](https://github.com/swoofer/essaim/commit/4cc059d007342d9b60536e422f9351a233b7ed4a))
* **metrics:** le budget de temps doit couvrir la lecture du corps ([#58](https://github.com/swoofer/essaim/issues/58)) ([#94](https://github.com/swoofer/essaim/issues/94)) ([2472924](https://github.com/swoofer/essaim/commit/247292460015e97b36eefb3a3d3f189c573fd07f))
* **workspace:** ESSAIM_RESET_BASE nomme le répertoire à détruire ([#56](https://github.com/swoofer/essaim/issues/56)) ([#103](https://github.com/swoofer/essaim/issues/103)) ([8ab3ecf](https://github.com/swoofer/essaim/commit/8ab3ecf13c7067bbe8d8ff2e1d4af8fb856fc32e))


### Documentation

* **readme:** documente ESSAIM_RESET_BASE et son contrat de chemin ([#104](https://github.com/swoofer/essaim/issues/104)) ([1235016](https://github.com/swoofer/essaim/commit/1235016bfc81fa561b1243f846352fcb9699c576))
* **security:** marque les plans et la spec comme livrés, signale le pan périmé ([#92](https://github.com/swoofer/essaim/issues/92)) ([9bb0637](https://github.com/swoofer/essaim/commit/9bb0637080ba2fcebd3af9b18b55cf912b8c06b7))

## [0.8.1](https://github.com/swoofer/essaim/compare/v0.8.0...v0.8.1) (2026-08-13)


### Bug Fixes

* **catalog:** interpole ou retire les params que l'assemblage jetait ([#79](https://github.com/swoofer/essaim/issues/79)) ([#87](https://github.com/swoofer/essaim/issues/87)) ([bef272a](https://github.com/swoofer/essaim/commit/bef272a451d3b363a086d652dda0cdc78d158786))
* **test:** n'exige les bits POSIX que là où ils existent ([#91](https://github.com/swoofer/essaim/issues/91)) ([607c95f](https://github.com/swoofer/essaim/commit/607c95f64f6c0333b3c4285e0d7722574545d6a2))

## [0.8.0](https://github.com/swoofer/essaim/compare/v0.7.0...v0.8.0) (2026-07-23)


### Features

* **coordination:** handle ADJUST decisions from the coordination LLM ([#73](https://github.com/swoofer/essaim/issues/73)) ([87d0537](https://github.com/swoofer/essaim/commit/87d05371289233fff6fbd8dd0dade6d76a3248e0))
* **security:** forward Strix custom LLM endpoint + tuning vars (proxy/self-hosted support) ([c8fd372](https://github.com/swoofer/essaim/commit/c8fd37221a54719357b4009ae5189c929b38d948))
* **security:** invoke Strix as host CLI, read strix_runs artifacts; secrets to child env (no disk) ([b601c10](https://github.com/swoofer/essaim/commit/b601c100d2a812ec9b36ac7f8722ed6f803065a3))
* **security:** parse real Strix vulnerabilities.json + SARIF; scan_mode gains standard ([5ccbd9d](https://github.com/swoofer/essaim/commit/5ccbd9d0a414715f433843bd5ccfc2a06f60a17d))
* **security:** pluggable multi-engine security subsystem (v1: Strix) ([#70](https://github.com/swoofer/essaim/issues/70)) ([bae2edb](https://github.com/swoofer/essaim/commit/bae2edb6502ebb8580217dcdca3abc173eed8fb8))


### Bug Fixes

* **agent-launcher:** handle spawn errors and resolve the claude binary robustly ([#64](https://github.com/swoofer/essaim/issues/64)) ([dbe5b44](https://github.com/swoofer/essaim/commit/dbe5b44c2fbebd037f507c7ce9a29fd390ac750e))
* **agent-loop:** release task and mark run as rate-limited when still rate-limited after retry ([#61](https://github.com/swoofer/essaim/issues/61)) ([4f750ca](https://github.com/swoofer/essaim/commit/4f750ca06bad5984dba46095774896d738149a75))
* **claude-stream:** decode stdout as UTF-8 to avoid split-codepoint corruption ([#65](https://github.com/swoofer/essaim/issues/65)) ([6463715](https://github.com/swoofer/essaim/commit/646371562fe121e884a57868194c986f47829ef9))
* **coordination:** dedupe ask_llm_decide requests per round ([#67](https://github.com/swoofer/essaim/issues/67)) ([d50d1c8](https://github.com/swoofer/essaim/commit/d50d1c8604dd6c0e1c4619bdd27b34010b4a9dee))
* **hooks:** report workspace-relative paths from submodule checkouts ([#75](https://github.com/swoofer/essaim/issues/75)) ([84bf558](https://github.com/swoofer/essaim/commit/84bf558ba6e81ed045fca47621d8f4b26ac35cf3))
* **mqtt:** honor reconnect budget on post-connect errors, catch up missed consultations ([#63](https://github.com/swoofer/essaim/issues/63)) ([4886de3](https://github.com/swoofer/essaim/commit/4886de39a74e0d2912a0fd6eb642af3f1d9dd74b))
* **mqtt:** preserve coordinator URL path when deriving the WS URL ([655b176](https://github.com/swoofer/essaim/commit/655b176640bf48414afeaec791ad6cbf0b934788))
* **orchestrator:** cap concurrent agent launches and refuse resetBase's implicit-cwd clean ([#74](https://github.com/swoofer/essaim/issues/74)) ([dc186b1](https://github.com/swoofer/essaim/commit/dc186b1b35fc2e7f837aeef1eda6795e63a39215))
* **orchestrator:** skip unregistered agents, scope metrics to the run, drain before teardown, guard resolution counts ([#69](https://github.com/swoofer/essaim/issues/69)) ([c106952](https://github.com/swoofer/essaim/commit/c1069527ba758a855d67e967b362471e11598fb9))
* **pipeline:** validate hooks arrays and reject non-scalar values ([#68](https://github.com/swoofer/essaim/issues/68)) ([d7afe86](https://github.com/swoofer/essaim/commit/d7afe86c99abab57b025b2a2d315d13733d9098b))
* **security:** recompute fingerprint after SARIF backfill; env allowlist for strix child; per-element parse resilience ([ac3b45a](https://github.com/swoofer/essaim/commit/ac3b45a215ff32b309e98aa397063164e27ecfb5))
* **security:** Strix adapter — real host-CLI invocation + strix_runs artifacts ([90764b2](https://github.com/swoofer/essaim/commit/90764b25f162a0a50aa9faf90f21d22bb98726ae))
* **security:** use a concrete loopback in LLM_API_BASE examples (satisfy hermetic guard) ([b682861](https://github.com/swoofer/essaim/commit/b6828614157473c1e86b762cf208d32cb77bf307))
* **track-activity:** skip sensitive file content and send the coordinator auth token ([#66](https://github.com/swoofer/essaim/issues/66)) ([94d199a](https://github.com/swoofer/essaim/commit/94d199a8baa2a46f570c7f2f8f139c24b8a011cf))
* **work-stealing:** refetch busyFiles after a lost claim race ([#62](https://github.com/swoofer/essaim/issues/62)) ([d3cd363](https://github.com/swoofer/essaim/commit/d3cd363128e85be5b6cb87923da693e47587f885))


### Documentation

* **security:** Strix adapter real-invocation design (CLI + files + verified schema + pinned sandbox digest) ([4f2b36c](https://github.com/swoofer/essaim/commit/4f2b36c1eb58361fddb08ec8cdedc4e525f36bcf))
* **security:** Strix invoked as host CLI (pip install strix-agent) driving a pinned Docker sandbox ([c396823](https://github.com/swoofer/essaim/commit/c396823d13479f7c19174dfe1aff4676c7f254c3))

## [0.7.0](https://github.com/swoofer/essaim/compare/v0.6.0...v0.7.0) (2026-07-14)


### Features

* **bughunt:** contrat de sortie Essaim-Target — clé stable de dédup des findings ([#44](https://github.com/swoofer/essaim/issues/44)) ([4dc9df5](https://github.com/swoofer/essaim/commit/4dc9df5d61ce914d158c6d0e1500b8fad599d281))
* **catalog:** catalogues externes — --catalog, ESSAIM_CATALOG, .essaim/ projet ([#45](https://github.com/swoofer/essaim/issues/45)) ([9f89cf9](https://github.com/swoofer/essaim/commit/9f89cf93e5992b3b72bf202bfce277bc66c85eaf))
* **catalog:** safety behavior dir-output — writes confined to an allowlist of directories ([a60ff5d](https://github.com/swoofer/essaim/commit/a60ff5df25a730e470d11ea1aff5079d8440318e))
* **cli:** --set-file — param values read verbatim from files ([#35](https://github.com/swoofer/essaim/issues/35)) ([d89f07b](https://github.com/swoofer/essaim/commit/d89f07b4699796a6dda972de9ce639ef911f4862))
* **pipeline:** essaim pipeline CLI command + docs ([#36](https://github.com/swoofer/essaim/issues/36)) ([93fe549](https://github.com/swoofer/essaim/commit/93fe5490b9cc8dac07a395634e87586678181859))
* **pipeline:** schema loader + sequential runner ([#36](https://github.com/swoofer/essaim/issues/36)) ([fc19d01](https://github.com/swoofer/essaim/commit/fc19d01d0a7f6e834d9724c695391266a83bdceb))
* **work-stealing:** estampille le run_id — le pool ne voit plus les runs morts ([#32](https://github.com/swoofer/essaim/issues/32)) ([#43](https://github.com/swoofer/essaim/issues/43)) ([b47acfb](https://github.com/swoofer/essaim/commit/b47acfb8f10cffa0e52f09b31f83b5965dea438b))


### Bug Fixes

* **catalog:** discovery-synth — consigne explicite de graphie sans accents des titres du squelette (le LLM accentuait « Problème », finding pilote 3a [#4](https://github.com/swoofer/essaim/issues/4)) ([afab644](https://github.com/swoofer/essaim/commit/afab6446ad7386dc100f23013452595504fab86c))
* **catalog:** restore fail-fast on discovery params — smoke test provides per-template setParams instead of weakening required ([3cf9b9a](https://github.com/swoofer/essaim/commit/3cf9b9accc27f7330c117ede5cb2245833e2b62e))
* **cli:** --set coerces per declared catalog type — string params keep numeric-looking values ([#28](https://github.com/swoofer/essaim/issues/28)) ([0d8237f](https://github.com/swoofer/essaim/commit/0d8237f73e4b913ed0442bcac31e68fd692ab4c6))
* **coordination:** gate sequential pipelines on artifacts, not thread status ([#38](https://github.com/swoofer/essaim/issues/38)) ([#39](https://github.com/swoofer/essaim/issues/39)) ([eb8660a](https://github.com/swoofer/essaim/commit/eb8660ad3afce5a8703e7e05e741d07417b1a68f))
* **pilote:** 4 bugs du backlog — auth métriques, marqueur DONE, allowlist solo, boucle MQTT ([#40](https://github.com/swoofer/essaim/issues/40)) ([80d7038](https://github.com/swoofer/essaim/commit/80d7038a3e6a56f9649cb38badfe2b4f68325823))
* **work-stealing:** un seul agent par fichier — dédup structurelle des findings ([#30](https://github.com/swoofer/essaim/issues/30)) ([#41](https://github.com/swoofer/essaim/issues/41)) ([a5973f8](https://github.com/swoofer/essaim/commit/a5973f879761fbce7bb64db9a7d3974b0499ad16))


### Code Refactoring

* **run:** extract executeRun into run-core for reuse ([73c662f](https://github.com/swoofer/essaim/commit/73c662faa70d52253635f7089d7d8fe03ee078c1))

## [0.6.0](https://github.com/swoofer/essaim/compare/v0.5.0...v0.6.0) (2026-07-11)


### ⚠ BREAKING CHANGES

* **catalog:** migrate swarm templates to YAML (templates/ + .essaim/templates/ project overrides)

### Features

* **auth:** auth headers in generated .mcp.json (agent workspaces + init) ([3007333](https://github.com/swoofer/essaim/commit/3007333cdae71e710d4c6180b95bbe90d3f902c7))
* **auth:** COORDINATOR_TOKEN helper — Bearer headers + .mcp.json patcher ([bf27e0a](https://github.com/swoofer/essaim/commit/bf27e0aa3110b5b6498792e1bf05beecc054d192))
* **auth:** pass coordinator token as MQTT credentials ([774a5b3](https://github.com/swoofer/essaim/commit/774a5b34fda0f32dc85dedd43964e8b1fca59d85))
* **auth:** send Bearer token on all coordinator REST calls ([d38e93c](https://github.com/swoofer/essaim/commit/d38e93c7fac11205ef7234358c4bb6793c7696ac))
* **behaviors:** add user-brief — free-form per-run context injection ([#13](https://github.com/swoofer/essaim/issues/13)) ([294b941](https://github.com/swoofer/essaim/commit/294b941d3c19a20abd43b405f884fd8c5ae0002e))
* **behaviors:** split read-only-mode + add audit-output ([#15](https://github.com/swoofer/essaim/issues/15)) ([8ef65a6](https://github.com/swoofer/essaim/commit/8ef65a6916aa6dbbd3612bd1843eb8d343cfc868))
* **catalog:** behavior mission-tasks-md (règles d'implémentation de tâches) ([74f4231](https://github.com/swoofer/essaim/commit/74f4231330f424d729169afee39fe0ffec4e48a2))
* **catalog:** migrate swarm templates to YAML (templates/ + .essaim/templates/ project overrides) ([0027a17](https://github.com/swoofer/essaim/commit/0027a17a8f0e22da8631dbad10e79ef9131887d5))
* **cli:** entry point + version helper (delete paths-stub) ([0684710](https://github.com/swoofer/essaim/commit/0684710433ec40cc9e95f459720210084190af6e))
* coordinator auth (COORDINATOR_TOKEN) + YAML template catalog ([256986d](https://github.com/swoofer/essaim/commit/256986db8c8ab3781002e0792f48e6aeb93a653c))
* **hooks:** PreToolUse start + PostToolUse content + working-files stop for v0.6 coordinator ([cc10862](https://github.com/swoofer/essaim/commit/cc108627752aa3e33ab7a428523fdeea93bbe2a9))
* **hooks:** wire v0.6 coordinator endpoints (PreToolUse + content + working-files) ([fc13009](https://github.com/swoofer/essaim/commit/fc130091f27dc2e09c8ad62c54eaaa0ad6f8c608))
* import agent-loop source from monorepo (with temp paths-stub for build) ([ac6b4a4](https://github.com/swoofer/essaim/commit/ac6b4a42eeab3eaf1c21689be408f8af1947c50d))
* import bridge.ts from monorepo bce/engine/ ([94ebcfc](https://github.com/swoofer/essaim/commit/94ebcfc1e9eb8ca00a5d0aa4b093ad83a78787f6))
* import catalog from monorepo (32 behaviors, 21 presets, 3 compositions, 6 hook scripts) ([11adb5e](https://github.com/swoofer/essaim/commit/11adb5e8b51c5ab08b5075f863e0ef623ec2f6d3))
* import CLI commands + utils from monorepo (rewrite imports + self-update string rewrites) ([7956906](https://github.com/swoofer/essaim/commit/7956906317ce4c4c88a39524dddb0491d91dc492))
* import orchestrator source from monorepo (with temp paths-stub + bce import shims) ([fddc256](https://github.com/swoofer/essaim/commit/fddc256405fab50242d87c422cf6ba6f2cb8bebd))
* in-process coordinator launch (Strategy A) with --coordinator-url override ([3f69f1f](https://github.com/swoofer/essaim/commit/3f69f1f134e12c4b502c7fdb082b3d1d57a0789f))
* **index:** re-export public surface for programmatic consumers ([046f6dc](https://github.com/swoofer/essaim/commit/046f6dc60c5878ed109a3cf2dcb2cc5f4fc73408))
* **presets:** add `phare` template — 4 specialists + 1 reconciliator for multi-angle audits ([0c24db1](https://github.com/swoofer/essaim/commit/0c24db1319570e3329ed81e43c2a7790218317a8))
* **template:** add `migrate-phase2` — N agents migrate N modules in parallel ([27cf042](https://github.com/swoofer/essaim/commit/27cf0423876899d39c63e8bba7d0d5637775ff2b))


### Bug Fixes

* **auth:** reference token as ${COORDINATOR_TOKEN} in generated .mcp.json -- never the literal secret ([07b3280](https://github.com/swoofer/essaim/commit/07b32804e7de56170ed9eae2b0c89dad3daaece8))
* bump ip-address override to ^10.2.0 to satisfy socks too ([2a57820](https://github.com/swoofer/essaim/commit/2a57820d7dafb84f0f89be16d5753c492bb07294))
* **catalog:** resolve project-local .essaim/templates at CLI pre-flight (new project-only templates runnable) ([08328f7](https://github.com/swoofer/essaim/commit/08328f70eaa2ac4efd258b10f17b99f72884464d))
* **cli:** emit deprecation warning when --url is used ([08a03d0](https://github.com/swoofer/essaim/commit/08a03d06c15ca306237d92d6cb45f694c4b46927))
* encoding mojibake throughout source + portable path test ([687c916](https://github.com/swoofer/essaim/commit/687c9162263ccc760f315fb67a9c012b721fe209))
* **hooks:** normalize file_path to repo-relative before POST ([40db10c](https://github.com/swoofer/essaim/commit/40db10cce33b44609a00907c29cec676a8ab3671))
* **hooks:** normalize file_path to repo-relative before POST to coordinator ([494b023](https://github.com/swoofer/essaim/commit/494b023dd13f5e164915361c77162fb5b9121fea))
* **landing:** unescaped closing quote in i18n string broke JS parsing ([4bb7bca](https://github.com/swoofer/essaim/commit/4bb7bcaa4aca7ac828fa1469cfa702b29e535672))
* **orchestrator:** wrap fileURLToPath in try/catch for Bun --compile resilience ([9a449ce](https://github.com/swoofer/essaim/commit/9a449ce93b4e75ef7074e52f73040ab106177e1b))
* override ip-address to 10.1.1 to resolve transitive vulnerability ([a591f4e](https://github.com/swoofer/essaim/commit/a591f4e3b84c986b75baaec4e781de23cd5eb8c9))
* **readme:** drop fake `essaim bce` subcommands that don't exist in the CLI ([#12](https://github.com/swoofer/essaim/issues/12)) ([46baae7](https://github.com/swoofer/essaim/commit/46baae7cd4a40c7d24e01102cfafeab7dcc8490f))
* **test:** bce-coverage.test phantom 'sequential-pipeline' behavior reference ([fc37ecf](https://github.com/swoofer/essaim/commit/fc37ecfc5c526b02913e39980643a631258f648f))
* **windows:** replace execSync curl with fetch; propagate modules to /api/register ([88ba5b4](https://github.com/swoofer/essaim/commit/88ba5b4636ab26aeca6c43cbbfc523ac381d48af))
* **workspace:** make resetBase opt-in via ESSAIM_RESET_BASE=1 ([d86ce53](https://github.com/swoofer/essaim/commit/d86ce53e2da609c5e9b148382c56c6288827bb93))


### Documentation

* add Buy Me A Coffee + GitHub Sponsors links across surfaces ([c47b4d7](https://github.com/swoofer/essaim/commit/c47b4d75423b6a13bf76425f6a16f559aa266d93))
* add Contributor License Grant (relicense optionality) ([a41bcbb](https://github.com/swoofer/essaim/commit/a41bcbbbe9fb4deb149c2be2a5dd3aae144fa948))
* **contributing:** add Contributor License Grant for relicense optionality ([48590da](https://github.com/swoofer/essaim/commit/48590dad415effd10e71ad5aac559f7ff14a605f))
* full v0.1.0 README adapted from source mcp-coordinator README + bce/README ([d2810de](https://github.com/swoofer/essaim/commit/d2810de1b5e8f7ab304260cd413c647c10a52199))
* **landing:** adapt source mcp-coordinator landing for orchestrator scope (i18n 6 langs) ([abcf382](https://github.com/swoofer/essaim/commit/abcf382c19259066c6b723577b41836aef831af0))
* **readme:** trim mcp-coordinator overlap (-48% length) ([#11](https://github.com/swoofer/essaim/issues/11)) ([73cb82e](https://github.com/swoofer/essaim/commit/73cb82e8b6aca98547bcf13c3c71619c32d0091e))
* **seo:** add Open Graph + Twitter Cards + sitemap + robots.txt ([8ddf34c](https://github.com/swoofer/essaim/commit/8ddf34c01754803367f084aad8288ee4ca69d48f))


### Code Refactoring

* **migrate-phase2:** scaffold-first + workspace shared ([496c60a](https://github.com/swoofer/essaim/commit/496c60a802bf6fc9323b807f8a5f0a45bb388bc2))
* replace paths-stub.ts with cli/bce-resolver.ts (walk-up + Bun --compile resilient) ([feba62e](https://github.com/swoofer/essaim/commit/feba62ed903cf951efd0206f89bdc02b86e1597a))
* replace server/src/* type imports with mcp-coordinator/types ([2d5acde](https://github.com/swoofer/essaim/commit/2d5acde8c2f816d551dc3879448c5b0f90325a7e))
* thread promptweave imports through public API (fix bce-* test imports) ([e7a083c](https://github.com/swoofer/essaim/commit/e7a083c2b7260da583b155d1fef6f206cfc2d644))

## [0.5.0](https://github.com/swoofer/essaim/compare/v0.4.0...v0.5.0) (2026-05-26)


### Features

* **presets:** add `phare` template — 4 specialists + 1 reconciliator for multi-angle audits
* **behaviors:** add `audit-specialist` and `audit-reconciliator` building blocks for any multi-angle audit

## [0.4.0](https://github.com/swoofer/essaim/compare/v0.3.0...v0.4.0) (2026-05-26)


### Features

* **behaviors:** split read-only-mode + add audit-output ([#15](https://github.com/swoofer/essaim/issues/15)) ([8ef65a6](https://github.com/swoofer/essaim/commit/8ef65a6916aa6dbbd3612bd1843eb8d343cfc868))

## [0.3.0](https://github.com/swoofer/essaim/compare/v0.2.0...v0.3.0) (2026-05-24)


### Features

* **behaviors:** add user-brief — free-form per-run context injection ([#13](https://github.com/swoofer/essaim/issues/13)) ([294b941](https://github.com/swoofer/essaim/commit/294b941d3c19a20abd43b405f884fd8c5ae0002e))


### Bug Fixes

* **hooks:** normalize file_path to repo-relative before POST ([40db10c](https://github.com/swoofer/essaim/commit/40db10cce33b44609a00907c29cec676a8ab3671))
* **hooks:** normalize file_path to repo-relative before POST to coordinator ([494b023](https://github.com/swoofer/essaim/commit/494b023dd13f5e164915361c77162fb5b9121fea))
* **readme:** drop fake `essaim bce` subcommands that don't exist in the CLI ([#12](https://github.com/swoofer/essaim/issues/12)) ([46baae7](https://github.com/swoofer/essaim/commit/46baae7cd4a40c7d24e01102cfafeab7dcc8490f))


### Documentation

* add Contributor License Grant (relicense optionality) ([a41bcbb](https://github.com/swoofer/essaim/commit/a41bcbbbe9fb4deb149c2be2a5dd3aae144fa948))
* **contributing:** add Contributor License Grant for relicense optionality ([48590da](https://github.com/swoofer/essaim/commit/48590dad415effd10e71ad5aac559f7ff14a605f))
* **readme:** trim mcp-coordinator overlap (-48% length) ([#11](https://github.com/swoofer/essaim/issues/11)) ([73cb82e](https://github.com/swoofer/essaim/commit/73cb82e8b6aca98547bcf13c3c71619c32d0091e))

## [0.2.0](https://github.com/swoofer/essaim/compare/v0.1.1...v0.2.0) (2026-05-10)


### Features

* **hooks:** PreToolUse start + PostToolUse content + working-files stop for v0.6 coordinator ([cc10862](https://github.com/swoofer/essaim/commit/cc108627752aa3e33ab7a428523fdeea93bbe2a9))
* **hooks:** wire v0.6 coordinator endpoints (PreToolUse + content + working-files) ([fc13009](https://github.com/swoofer/essaim/commit/fc130091f27dc2e09c8ad62c54eaaa0ad6f8c608))

## [0.1.1](https://github.com/swoofer/essaim/compare/v0.1.0...v0.1.1) (2026-05-06)


### Bug Fixes

* bump ip-address override to ^10.2.0 to satisfy socks too ([2a57820](https://github.com/swoofer/essaim/commit/2a57820d7dafb84f0f89be16d5753c492bb07294))
* encoding mojibake throughout source + portable path test ([687c916](https://github.com/swoofer/essaim/commit/687c9162263ccc760f315fb67a9c012b721fe209))
* **landing:** unescaped closing quote in i18n string broke JS parsing ([4bb7bca](https://github.com/swoofer/essaim/commit/4bb7bcaa4aca7ac828fa1469cfa702b29e535672))
* override ip-address to 10.1.1 to resolve transitive vulnerability ([a591f4e](https://github.com/swoofer/essaim/commit/a591f4e3b84c986b75baaec4e781de23cd5eb8c9))

# Changelog

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

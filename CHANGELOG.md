# Changelog

All notable changes to Scriipture follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Gate 3 could attest `passed` on a run where the solver never executed, and on one where it found a violation.** Three separate causes, all now fixed:
  - **Findings were never captured.** The filter accepted only diagnostics whose `errorCode` starts with `64`; CHC and BMC emit around fifty codes and none of them does (assertion violation is 6328, overflow 4984, underflow 3944, division by zero 4281). Findings are now recognised by the `CHC:` / `BMC:` message prefix that every SMTChecker diagnostic carries.
  - **The verdict was read from solc's severity.** The SMTChecker reports everything through `warning()` and `info()` and never `error()`, so a real counterexample was filed as a warning and the gate could not fail. The verdict now comes from the message: `… happens here` is a counterexample and fails the gate, `… might happen here` is unproved. This also means a violated `@invariant` is no longer attested as proven.
  - **A solc with no Horn solver was recorded as a clean run.** The official release binaries and `brew install solidity` are built without Z3; they emit `7649 CHC analysis was not possible since no Horn solver was found and enabled` and `8158 Solver z3 was selected for SMTChecker but it is not available`, neither of which the old check matched. Both, and the equivalent codes 7710 / 4591 / 1180, are now recognised as "did not run".
- **A native solc that crashed was recorded as a clean run.** `spawnSync`'s `status`, `error` and `signal` were ignored, and empty stdout parsed as `{}` — no errors. A non-zero exit, a signal, a failed spawn and unparseable output are now each recorded as `ran: false` with the reason.
- **Gate results now record the `engine`** that produced them (e.g. `native-solc 0.8.37+commit.f401782d`), because two solc builds of the same version differ in whether the SMTChecker can run at all.
- **A proof attempt that settled nothing was recorded as `passed`.** `0/N proven` is now `skipped`: an auditor reads `passed` as *proved*.
- **The fuzz harness used unqualified struct and enum names**, so every contract using the types this release adds failed gate 7 with "Identifier not found or not unique" — `Item` and `Status` are members of the contract and must be written `Registry.Item` inside the harness. Enum parameters are also taken as a bounded `uint8` now, because the ABI decoder rejects an out-of-range enum before any `vm.assume` in the body could run, and methods taking a struct that contains an enum are skipped for the same reason.
- **A harness with no test function is no longer generated**, so a contract whose methods all take zero arguments (`examples/counter`) records gate 7 as `not-applicable` instead of failing on `forge: No tests match FuzzAuto`.
- **Every file-level `interface` became a struct**, so an interface with methods, or one that exists for a TypeScript consumer, emitted `struct IFoo {}` and solc rejected it. A declaration with no struct fields is now simply not a struct; one that mixes fields with members that cannot be lowered is reported and left unregistered rather than emitted half-formed.
- **`verify` and `audit` dropped parse diagnostics**, so a construct that could not be represented at all surfaced only as a confusing solc error at gate 2. Both now report them as gate 1 errors.
- **The SMTChecker harness was written into `out/sol`**, where `compile out/sol` globs it into a deployable artifact and Slither audits it as a contract. It goes to `out/smt/` now.
- **Gate 3 (SMTChecker) never actually ran.** The model-checker settings passed `contracts: { "<file>": [] }`, which solc rejects with "Source contracts must be a non-empty array"; the gate only looked at SMT findings, not compile errors, so every run reported "0 finding(s)". On top of that the bundled solc-js (Emscripten) build cannot start the Z3 solver thread at all. Model checking now runs through a native `solc` on the PATH (imports are inlined so it needs no filesystem access), and when no solver can run the gate is recorded as **skipped** with the reason, never as clean. `scriipture doctor` says so too.
- `scriipture audit --strict` now exits non-zero when Slither did not run instead of printing a note and passing.
- Gates 7 and 8 no longer announce "an invariant was violated" when forge could not run at all (forge-std clone failed, compile error); the gate still fails, but the detail says what actually happened, and a half-cloned forge-std is cleaned up before retrying.

### Added
- **Gate 8 gains a proof stage.** Alongside the forge invariant test (random call sequences: evidence), `verify` now emits an SMTChecker harness that inherits the contract and asserts every `@invariant`, and asks solc's CHC engine to prove each one over all reachable states. The attestation carries an `invariant-proof` gate result per contract with proven / unproven / violated invariants; a violation fails the gate. The docs no longer describe fuzzing as symbolic execution.
- **`require-checked-address` validator rule.** `CheckedAddress` was a TypeScript brand erased at emit, so `as Address` defeated it. The new rule traces `Address` parameters (and locals aliasing them) into `.transfer` / `.send` / `.call` / `.delegatecall` / `.staticcall` targets and `pullPayment()`, and reports any that did not pass through `validate()` or arrive typed `CheckedAddress`. Warning in `validate`, error under `--secure`; `@allowZeroAddress("…")` / `@unsafe("…")` opt out with a recorded justification. Rule count is now 16.
- `defineConfig()` is exported from `scriipture` for typed `scriipture.config.mjs` files; the example config and docs use it.
- `CompileResult.modelChecker` reports whether the SMTChecker ran, with which engine, and why not; `nativeSolc()` is exported.

### Changed
- npm keywords list only chains that ship (`base`, `base-sepolia`, `sepolia`); `optimism` and the misspelt `arbitrary` are gone.

- **Structs.** A file-level `interface Foo { … }` or `type Foo = { … }` next to the contract class becomes `struct Foo { … }` inside every contract in that file. Object literals lower to `Foo({a: x, b: y})`, taking the struct name from the slot they flow into (typed local, return value, state var initializer, `Map.set` / `push` on a state var, own-method argument) or from an explicit `{ … } as Foo`. Struct locals bound to storage (`const p = this.items.get(k)`) are emitted as `Foo storage p`, so writes through them reach storage. Struct params and returns get `memory`.
- **Enums.** A file-level `enum Status { A, B }` becomes `enum Status { A, B }` inside the contract; `Status.A` emits unchanged. Member initializers are a parse diagnostic (Solidity numbers members from 0).
- **Fixed-width integers and bytes.** `Uint8` … `Uint256`, `Int8` … `Int256` and `Bytes1` … `Bytes31` are exported from `scriipture` (as branded `bigint` / `string`) and map to the matching Solidity primitive. `Bytes` now maps to `bytes` and `Bytes32` to `bytes32` as primitives. Invalid widths (`Uint7`) are a parse diagnostic.
- IR: `IRType` gains `struct` and `enum` kinds and the full primitive name range; `IRContract` gains `structs` and `enums`; `IRExpression` gains `object`. Source maps include struct and enum declarations.

### Changed
- **`pack-slots` is now advisory.** It used to reorder `stateVars` in place — moving every small variable ahead of mappings, arrays and `uint256`s — which silently rewrote the storage layout of the emitted contract. It now reports the slot saving as a hint (`applied: false`) and leaves the declaration order alone. Pass `--reorder-storage` to `build` / `verify` to apply the suggested order. Library users: `optimizeProgram(program, { reorderStorage: true })`.
- **`pack-slots` counts slots the way solc does.** The baseline is now solc's own adjacent packing of the declared order (it never assumed one slot per variable), `constant` / `immutable` variables no longer count as slots, `string` / `bytes` are treated as full-slot dynamic types, and `Address` / `CheckedAddress` aliases are sized correctly. The pass runs after `immutable` and `constant` so those markings are visible to it. Previously the reported savings were usually fictional while the reordering was real.
- **Attestation gate results carry an explicit `status`** (`passed` | `failed` | `skipped` | `not-applicable`) and `schemaVersion` is bumped to `2`. `passed` is `true` only when the gate actually ran clean; a skipped gate used to be written as `passed: true, detail: "skipped"`, which made "clean" indistinguishable from "never ran". Skipped gates record the operator's justification when one is given; Mythril without `--deep` is recorded as `skipped` with `optIn: true`.
- **`secure-deploy` refuses to deploy when a gate was skipped** (`--no-smt`, `--no-slither`, `--no-fuzz`, `--no-invariants`, `--no-patterns`) unless `--allow-skipped-gates "<justification>"` is passed, matching the `@unsafe("…")` / `@allow*("…")` pattern. `secure-deploy` also accepts `--deep`.

### Fixed
- Gate 8 (invariant tests) recorded `passed: true` for every contract before forge ran, so a violated invariant blocked the deploy but the attestation still said the gate passed. The per-contract result now reflects the forge outcome, and `--skip fuzz-run` records the gate as skipped rather than passed.
- Gate 8 now creates the forge `src/` and `test/` directories itself, so `--skip fuzz` no longer makes invariant-test emission fail on a missing directory.
- `VerifyResult.gates` was always empty; it now contains every per-contract gate result as written to the attestation.

## [0.1.0] - 2026-08-15

First release under the **Scriipture** name. Version numbering restarts at `0.1.0`; the `0.2.x` entries below are the history of this same codebase under its former name, `solidscript`.

### Changed
- **Renamed the project from SolidScript to Scriipture.** This is a breaking change for every consumer.
  - The npm package is now **`scriipture`** (the old `solidscript` package is no longer updated). Install with `npm install scriipture`.
  - Imports change from `solidscript` / `solidscript/standards` to `scriipture` / `scriipture/standards`.
  - The CLI binary is now `scriipture` (e.g. `npx scriipture doctor`).
  - The project config file is now `scriipture.config.ts` / `scriipture.config.mjs` (was `solidscript.config.*`). Rename yours; the old filename is not read.
  - User-level state moved from `~/.solidscript/` to `~/.scriipture/`, covering `config.json` and `wallets/`. **Existing hot wallets and config are not migrated automatically** — move the directory yourself with `mv ~/.solidscript ~/.scriipture` before running the new CLI.
  - Attestation bundles now record the toolchain component as `scriipture` rather than `solidscript`, so attestations produced before and after this release differ in that field.

## [0.2.4] - 2026-05-13

### Fixed
- **Release workflow's "verify publish landed" step now retries with backoff** (up to ~90s, 18 attempts × 5s) instead of querying npm once after a fixed 5-second sleep. The npm CDN can take 30–60s to propagate a freshly-published version; v0.2.3's release workflow timed out at the verify step because of this lag, even though the publish itself succeeded. v0.2.4 is the first release that runs through Plan B end-to-end without manual intervention.

## [0.2.3] - 2026-05-13

### Fixed
- `scriipture --version` now reads from `package.json` at runtime instead of returning the hardcoded `0.0.1`. Resolves the version-reporting bug introduced in earlier releases.
- **Release workflow hardened against trailing `npm publish` 403s.** `npm publish --provenance` occasionally returns a non-zero exit code after successfully writing to the registry and pushing the provenance attestation to sigstore's transparency log (race between the registry write and the CLI's internal verify check). The release workflow now treats the publish step's exit code as advisory and uses a follow-up `npm view scriipture@$VERSION version` query to determine the real outcome. If the version is on the registry, the workflow proceeds to create the GitHub Release. If it's genuinely missing, the workflow hard-fails. This was discovered while shipping v0.2.2 — the package published successfully but the workflow reported failure, requiring manual `gh release create` to finish the release. v0.2.3 is the first release shipped through the fully automated path.

## [0.2.2] - 2026-05-13

### Added
- **Auto-pipx fallback** for Slither and Mythril in `scriipture doctor --fix`. Resolution order is now `PATH → Docker → pipx install`. When `pipx` is present and neither a native binary nor a Docker image is available, doctor automatically runs `pipx install slither-analyzer` / `pipx install mythril` instead of just printing the install hint.
- `scriipture doctor` (no `--fix`) now distinguishes between "Docker present" and "pipx present" in its hint text, so users see the exact path that will be tried.

### Fixed
- Removed dead `extract as tarExtract` import from `src/runtime/tool-paths.ts` that was producing a TypeScript declaration emit warning during build.

### Verified
- First release through the Plan B CI/CD workflow (GitHub Actions: tag push → `bun run build` → `npm publish --provenance --access public` → GitHub Release with tarball). 0.2.1 was the last manual publish.

## [0.2.1] - 2026-05-13

### Changed
- `scriipture.config.example.ts` renamed to `scriipture.config.example.mjs` to match what `scriipture init` writes
- `package.json` metadata filled in (author, repository URL, homepage, bugs)
- Docs updated to reflect the 9-gate pipeline (Mythril added as Gate 4 in 0.2.0; stale 8-gate references corrected throughout)

### Removed
- Dev-internal `SECURITY_SYSTEM_REPORT.md` (content folded into `docs/details.md` §8)
- Stray `contracts/TrillionToken.ts` artifact at repo root
- Working dev `scriipture.config.ts` — the `.example.mjs` is the template users copy

### Added
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, this `CHANGELOG.md`
- `.github/ISSUE_TEMPLATE/bug_report.yml`, `.github/ISSUE_TEMPLATE/feature_request.yml`
- `.github/PULL_REQUEST_TEMPLATE.md`, `.github/CODEOWNERS`
- `LANDING.md` — structured marketing-page content for the website

### Fixed
- `tests/fixtures/RequireToError.ts` moved to `tests/contracts/` (consolidated test-contracts under a single folder); test import updated

## [0.2.0] - 2026-05-12

### Added
- **Mythril gate** as Gate 4 of the verify pipeline (symbolic execution, opt-in via `--deep`)
- **`scriipture doctor --fix`** — auto-fetches Foundry binaries to `~/.scriipture/bin/` and pulls Slither/Mythril Docker images, making the toolchain self-contained after one command
- **Tool resolver** (`src/runtime/tool-paths.ts`) — every spawn site goes through a unified resolver with native + Docker fallback
- **OpenZeppelin v5 bundled** as a regular dependency (was peer dep in 0.1.x; now `npm install scriipture` brings it automatically)
- **Library entry point** at `src/index.ts` — programmatic API (`parseContractFiles`, `emitProgram`, `validateProgram`, `optimizeProgram`, `compileSolidity`, plus all IR types)
- **Etherscan v2 multichain verification** — one API key works for Base, Optimism, Arbitrum, Polygon, ZkSync, Ethereum, every testnet
- **Browser-wallet deploy** (`--browser` flag, default when no `--wallet`) — local HTTP bridge at `localhost:7654`, signs via MetaMask/Rabby/Coinbase Wallet
- **User-level config** at `~/.scriipture/config.json` (mode 0600) — `scriipture config set etherscan-key …` subcommand
- **GitHub Actions CI** — test matrix (node 18/20/22) + pack-smoke + security gates; release workflow on `v*` tag
- **`docs/details.md`** (14-section guide), **`docs/openapi.yaml`** (browser-deploy HTTP surface), **`docs/cli-commands.yaml`** (auto-generated CLI manifest)

### Changed
- Build pipeline switched from `tsc` to Bun's bundler — produces a tighter dist
- CLI shebang `#!/usr/bin/env bun` → `#!/usr/bin/env node` so the published package works under any Node-based runtime
- `scriipture init` now writes `scriipture.config.mjs` instead of `.ts` (Node ESM can load `.mjs` directly without a TS runtime)
- `scriipture verify` consolidated `--no-fuzz`, `--no-smt`, etc. into a single `--skip <gates>` flag
- `scriipture deploy` smart defaults: auto-`--browser` when no `--wallet` given, auto-verify when `etherscan-key` configured

### Fixed
- `attestation.ts:readScriiptureVersion()` now resolves Scriipture's own `package.json` via `import.meta.url` (was reading the user's project `package.json`)
- Custom-errors pass no longer produces double-negation (`if (!!emergencyMode)` → `if (emergencyMode)`)
- Unary operator emit wraps its operand in parens when needed (`!x >= y` → `!(x >= y)`)
- TS-only `Number(i)` / `BigInt(i)` casts stripped during parsing (don't leak into Solidity)
- `CheckedAddress` and `Bytes32` branded TS types alias to `address`/`bytes32` in generated Solidity
- `@invariant` decorator implies `view` mutability
- View-mutation rule no longer false-positives on local variable reassignment

## [0.1.0] - 2026-05-12

Initial public commit. TypeScript → Solidity transpiler with 8-gate security pipeline (gate 4 added in 0.2.0), forge bridge, examples, plugin API, attestation bundle, source maps, gasdiff, audit-pack, multi-chain deploy. See README and `docs/details.md` for the full feature surface.

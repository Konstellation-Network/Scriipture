# Contributing to Scriipture

Thanks for considering a contribution. Scriipture is a TypeScript→Solidity transpiler with a built-in 9-gate security pipeline, and we welcome help across all of it: new optimizer passes, new validator rules, new examples, docs, bug fixes.

This guide covers the dev loop, where to add things, and how to get a PR merged.

---

## Dev environment

Required:
- **Node 18+** (we test on 18, 20, 22 in CI)
- **Bun** for the dev workflow (faster than npm/yarn for our use case) — install via `curl -fsSL https://bun.sh/install | bash`
- **git**

Recommended (for the full test loop):
- `solc` native — `brew install solidity` (only needed if you touch the compiler or audit code paths)
- `slither` — `brew install slither-analyzer`
- `forge` + `anvil` — `curl -L https://foundry.paradigm.xyz | bash && foundryup`
- Docker (alternative to brewing slither/mythril) — pulls `trailofbits/eth-security-toolbox` and `mythril/myth` images

```bash
git clone https://github.com/usezoracle/Scriipture.git
cd Scriipture
bun install
bun run typecheck
bun test
bun run build           # produces dist/
```

Run the CLI from source during development:

```bash
bun run cli build examples
bun run cli verify examples --skip fuzz,invariants
```

`bun run cli` is shorthand for `bun run src/cli/index.ts` (defined in `package.json` scripts).

---

## Project layout

```
src/
├─ parser/          TS AST → IR
├─ mapper/          TS type → Solidity type, decorator → modifier/import
├─ emitter/         IR → Solidity text
├─ validator/       static rules (tx.origin, selfdestruct, …)
├─ optimizer/       custom-errors, immutable, slot packing, …
├─ compiler/        solc-js + SMTChecker
├─ audit/           Slither + Mythril integrations
├─ security/        fuzz harness gen, invariants, attestation, pattern library
├─ runtime/         tool-paths resolver (forge/anvil/Docker fallback)
├─ deploy/          viem deployer + network registry
├─ wallet/          local hot-wallet store + browser-deploy bridge
├─ sourcemaps/      .sol-line → .ts-line mapping
├─ config/          user-level config (~/.scriipture/config.json) + project config
├─ plugin/          plugin API + loader
├─ test-runner/     forge bridge
└─ cli/             every CLI subcommand
```

If you're adding something, here's the right home for it:

| What you're adding | Where it goes |
|---|---|
| A new optimizer pass | `src/optimizer/<name>.ts` + register in `src/optimizer/passes.ts` |
| A new validator rule | append to `src/validator/rules.ts` |
| A new CLI subcommand | `src/cli/<name>.ts` + wire in `src/cli/index.ts` |
| A new chain backend | `src/deploy/networks.ts` (add to `CHAINS`) |
| An example contract | `examples/<name>/<Contract>.ts` |
| A static analyzer integration | `src/audit/<tool>.ts` + new gate in `src/cli/verify.ts` |
| A new decorator | `types/index.d.ts` + handler in `src/mapper/decorators.ts` |

---

## Workflow for a typical change

1. **Branch off `main`**: `git checkout -b feat/short-description`.
2. **Make the change**. Add or update tests where applicable (see below).
3. **Run the suite**:
   ```bash
   bun run typecheck
   bun test
   bun run build
   ```
4. **Sanity-run against the bundled examples**:
   ```bash
   bun run cli build examples
   bun run cli verify examples --skip fuzz,invariants
   ```
5. **Open a PR** against `main`. Use the PR template — it asks 4 things.
6. **CI runs automatically**: typecheck + tests + build matrix (node 18/20/22) + pack-smoke + security gate against examples. All checks should be green before merge.

---

## Tests

We use Bun's built-in test runner (no Vitest/Jest). Unit tests live in `tests/*.test.ts`. Test contracts (forge `.t.ts` files + fixtures used by unit tests) live in `tests/contracts/`.

To run:

```bash
bun test                    # all
bun test parser             # match by filename
```

Adding tests for a new optimizer pass: snapshot the IR before and after the pass fires, plus a contract that exercises it under `tests/contracts/`.

Adding tests for a new validator rule: one contract under `tests/contracts/` that triggers the rule and one that doesn't. The test asserts the diagnostic appears for the former and not the latter.

---

## Pull request checklist

- [ ] Tests added or existing tests updated
- [ ] `bun run typecheck` passes
- [ ] `bun test` passes
- [ ] `bun run build` produces a clean `dist/`
- [ ] If user-facing: `README.md` or `docs/details.md` updated
- [ ] If a new dependency: justified in the PR description, no native-binary additions to npm (we use lazy-fetch + Docker, not bundled binaries)
- [ ] Commit messages explain *why*, not just *what*

---

## Code style

- TypeScript strict mode; no `any` unless interfacing with an untyped third-party
- 2-space indent
- Prefer named exports; default exports only where required (plugin entries)
- No `// TODO` left in main — leave a GitHub issue instead

---

## Reporting issues / security

- **Bugs and feature requests**: use the GitHub issue templates at https://github.com/usezoracle/Scriipture/issues/new/choose
- **Security vulnerabilities**: see [SECURITY.md](./SECURITY.md). Please don't open a public issue for security reports.

---

## License

By contributing, you agree your code will be released under the [MIT License](./LICENSE).

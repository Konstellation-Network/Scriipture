# Scriipture — full documentation

> **Write smart contracts in TypeScript. Ship audited Solidity.**
> A transpiler + 9-gate security pipeline + multi-chain deployer, in one package.

This document is written for a TypeScript developer who has **never written Solidity before**. By the end, you'll have a token deployed on Base Sepolia, source-verified on BaseScan, with a reproducible-build manifest in your repo.

---

## Table of contents

1. [What is Scriipture and why does it exist](#1-what-is-scriipture-and-why-does-it-exist)
2. [Install](#2-install)
3. [`scriipture doctor` — confirm your environment](#3-scriipture-doctor)
4. [Quickstart — token on Base Sepolia in 5 minutes](#4-quickstart)
5. [Decorators reference](#5-decorators-reference)
6. [Type mapping (TypeScript → Solidity)](#6-type-mapping)
7. [Every command, with examples](#7-commands)
8. [The 9-gate security pipeline](#8-the-9-gate-security-pipeline)
9. [Browser-wallet flow — why no private keys on disk](#9-browser-wallet-flow)
10. [Multi-chain deploy](#10-multi-chain-deploy)
11. [Source verification on block explorers](#11-source-verification)
12. [Plugins — extending the optimizer/validator](#12-plugins)
13. [Troubleshooting](#13-troubleshooting)
14. [Scriipture vs raw Solidity vs Hardhat vs Foundry](#14-comparison)

---

## 1. What is Scriipture and why does it exist

If you're a TypeScript developer, this is what writing a smart contract looks like in Scriipture:

```ts
import { Address, storage, view, onlyOwner, msg } from "scriipture";
import { ERC20 } from "scriipture/standards";

export class MyToken extends ERC20 {
  constructor(initialSupply: bigint) {
    super("MyToken", "MTK");
    this._mint(msg.sender, initialSupply);
  }

  @onlyOwner
  mint(to: Address, amount: bigint): void {
    this._mint(to, amount);
  }
}
```

Scriipture transpiles that into auditable, optimized Solidity, runs it through 8 independent security verifiers, and deploys it to any EVM chain. Your wallet signs the deploy through a browser extension — no private keys touch disk.

**Why not just learn Solidity?** You can. Bridges have lost ~$2B because experienced Solidity developers shipped subtle bugs that a transpiler-enforced restricted surface + mandatory static analysis would have caught. Scriipture's claim isn't "TS is intrinsically safer" — it's "the Scriipture pipeline forces safety properties that hand-written Solidity makes optional."

What the pipeline gives you for free:
- **OpenZeppelin inheritance auto-wired** by decorators (`@onlyOwner` → `Ownable`)
- **Constructor base-args auto-injected** (OZ v5's `Ownable(initialOwner)` requirement is invisible to you)
- **Custom errors auto-derived** from `require(_, "string")` calls (~50 gas per revert + bytecode shrink)
- **Solc compiles with optimizer + SMTChecker** (Z3 proves arithmetic safety)
- **Slither runs every build** (catches 70%+ of common vuln classes)
- **Forge fuzz harnesses auto-generated** (1000+ random inputs per public method)
- **Forge invariant tests auto-derived** from `@invariant` decorators
- **Reproducible-build attestation** signed for auditor handoff
- **Source maps** for `.sol:line` → `.ts:line` stack-trace rewriting
- **Etherscan/BaseScan verification** in one command
- **Browser-wallet signing** so deploys never need private keys on your filesystem

---

## 2. Install

Scriipture is a Node 18+ package. It runs under any package manager.

```bash
# Bun
bun add scriipture

# npm
npm install scriipture

# yarn
yarn add scriipture

# pnpm
pnpm add scriipture
```

**That's it for the npm install.** OpenZeppelin v5 + solc (JS) + TypeScript + viem ship as transitive dependencies of `scriipture`, so a single install brings everything the contract pipeline needs at runtime.

For the heavy native tools (forge, anvil, slither, mythril) run one more command:

```bash
npx scriipture doctor --fix
```

This auto-downloads Foundry (`forge`, `anvil`) from the official GitHub release for your platform into `~/.scriipture/bin/` and pulls the Slither + Mythril Docker images so you don't need to touch Python or Rust toolchains yourself. After that everything is self-contained.

### Optional: Docker

If Docker is on your PATH, `doctor --fix` will pull `trailofbits/eth-security-toolbox` and `mythril/myth` and Scriipture will run Slither/Mythril through Docker transparently. You never see Python.

If you don't want Docker, you can install the native tools yourself (`brew install slither-analyzer`, `pipx install mythril`) and Scriipture will pick them up from PATH. Either way works.

### External tools — all auto-managed

You used to have to install ~5 tools (solc, slither, mythril, forge, anvil) manually. **Not anymore.** `scriipture doctor --fix` handles everything:

| Tool | How Scriipture gets it |
|---|---|
| `node` (≥18) | already on macOS dev machines |
| solc (JS) | bundled with the npm install — no native solc required |
| **forge + anvil** | auto-downloaded from Foundry GitHub release on first use or via `doctor --fix` |
| **slither** | Docker (`trailofbits/eth-security-toolbox`) if Docker is installed; native `slither` on PATH otherwise |
| **mythril** | Docker (`mythril/myth`) if Docker is installed; native `myth` on PATH otherwise |

So the full onboarding is two commands:

```bash
npm install scriipture
npx scriipture doctor --fix
```

The `doctor` subcommand (without `--fix`) shows you current status — what's auto-cached, what's coming from PATH, what's missing. Run it any time.

---

## 3. `scriipture doctor`

Always your first command in a fresh environment:

```bash
npx scriipture doctor
```

Sample clean run:

```
scriipture doctor — environment check

  ✓ node                                     v25.9.0
  ✓ bun                                      1.3.10
  ✓ @openzeppelin/contracts (in your project) 5.6.1
  ✓ solc (native, for Slither)               solc, the solidity compiler...
  ✓ slither (static analyzer)                0.11.5
  ✓ forge (Foundry)                          forge Version: 1.4.4-stable
  ✓ anvil (local EVM)                        anvil Version: 1.4.4-stable

✓ environment is fully equipped
```

If anything is missing, doctor prints the install command for that piece. Required misses exit nonzero so you can wire this into CI.

---

## 4. Quickstart

End-to-end: empty directory → ERC20 token deployed on Base Sepolia → source verified on BaseScan. 5 minutes.

```bash
# 1. Make a project
mkdir my-token && cd my-token
npm init -y
npm install scriipture

# 2. Scaffold
npx scriipture init

# 3. Replace contracts/Counter.ts with a token (or add a new file)
cat > contracts/MyToken.ts <<'EOF'
import { Address, onlyOwner, msg } from "scriipture";
import { ERC20 } from "scriipture/standards";

export class MyToken extends ERC20 {
  constructor(initialSupply: bigint) {
    super("MyToken", "MTK");
    this._mint(msg.sender, initialSupply);
  }

  @onlyOwner
  mint(to: Address, amount: bigint): void {
    this._mint(to, amount);
  }
}
EOF

# 4. Transpile to Solidity
npx scriipture build contracts

# 5. Run the security pipeline (skip forge if you don't have it yet)
npx scriipture verify contracts --skip fuzz,invariants

# 6. Compile with solc-js
npx scriipture compile out/sol

# 7. Configure Etherscan API key (once)
#    Get a free key at https://etherscan.io/myapikey
npx scriipture config set etherscan-key YOUR_KEY

# 8. Deploy via browser wallet — opens MetaMask/Rabby/Coinbase Wallet to sign
npx scriipture deploy MyToken -n base-sepolia -a 1000000

# That's it. The CLI will:
#  • open your default browser at http://127.0.0.1:7654/
#  • you click "Connect wallet & deploy"
#  • your wallet pops up — switch to Base Sepolia, sign the deploy
#  • the CLI captures the tx hash, waits for confirmation
#  • prints the deployed address
#  • automatically submits source to BaseScan to verify (since etherscan-key is configured)
```

You'll see something like:

```
✓ deployed MyToken
  network:  base-sepolia
  tx:       0x...
  address:  0x...
verifying MyToken on base-sepolia…
✓ Pass - Verified
  https://sepolia.basescan.org/address/0x...#code
```

Click the URL — you'll see your TS-compiled Solidity rendered as a normal verified contract on BaseScan.

---

## 5. Decorators reference

Every decorator and the Solidity it produces:

| Decorator | TS usage | Solidity output |
|---|---|---|
| `@storage` | `@storage balance: bigint = 0n;` | `uint256 public balance;` (state variable) |
| `@view` | `@view balanceOf(a: Address): bigint { ... }` | `function … public view returns (uint256) { … }` |
| `@pure` | `@pure add(a: bigint, b: bigint): bigint { return a + b; }` | `function … public pure returns (uint256) { … }` |
| `@payable` | `@payable deposit(): void { ... }` | `function deposit() public payable { … }` |
| `@onlyOwner` | `@onlyOwner mint(...) { ... }` | `function … public onlyOwner` + `import Ownable` + `is Ownable` + constructor `Ownable(msg.sender)` auto-injected |
| `@nonReentrant` | `@nonReentrant withdraw(...) { ... }` | `function … nonReentrant` + `import ReentrancyGuard` + `is ReentrancyGuard` |
| `@whenNotPaused` | `@whenNotPaused doX(...) { ... }` | `function … whenNotPaused` + `import Pausable` + `is Pausable` |
| `@invariant` | `@invariant solvent(): boolean { return totalAssets >= totalLiabilities; }` | becomes a Forge `invariant_solvent()` fuzz test **and** an SMTChecker `assert(solvent())` proof obligation, both generated and run during `verify` |
| `@assembly` | `@assembly add(a: bigint, b: bigint): bigint { return yul\`add(a, b)\` }` | `function … { assembly { add(a, b) } }` — body inlined as Yul |
| `@unsafe("reason")` | `@unsafe("legacy contract requires tx.origin")` | annotation only — silences the secure-mode footgun check, recorded in the audit pack |
| `@allowTxOrigin("…")`, `@allowSelfdestruct("…")`, `@allowZeroAddress("…")`, `@allowLowLevelCall("…")` | targeted overrides for specific patterns | bypasses just that one secure-mode rule, with the justification stored in attestation |

Multiple decorators stack:

```ts
@onlyOwner
@nonReentrant
@whenNotPaused
mint(to: Address, amount: bigint): void {
  this._mint(to, amount);
}
```

→ `function mint(address to, uint256 amount) public onlyOwner nonReentrant whenNotPaused { _mint(to, amount); }` with all three OZ bases auto-inherited.

---

## 6. Type mapping

| TypeScript | Solidity |
|---|---|
| `bigint` | `uint256` |
| `number` | `uint256` |
| `boolean` | `bool` |
| `string` (state) | `string` |
| `string` (param/local) | `string memory` (or `calldata` after optimizer) |
| `Uint8` … `Uint256` | `uint8` … `uint256` (any multiple of 8) |
| `Int8` … `Int256` | `int8` … `int256` (any multiple of 8) |
| `Address` | `address` |
| `CheckedAddress` | `address` (compile-time guarantee it's non-zero — see [browser-wallet flow](#9)) |
| `Bytes1` … `Bytes32` | `bytes1` … `bytes32` |
| `Bytes` | `bytes` |
| `Map<K, V>` | `mapping(K => V)` |
| `Array<T>` | `T[]` (storage) / `T[] memory` (memory) |
| `interface Foo { … }` / `type Foo = { … }` (file level) | `struct Foo { … }` declared inside the contract |
| `enum Foo { A, B }` (file level) | `enum Foo { A, B }` declared inside the contract |
| `void` | (no return) |
| `null` | not supported |
| `undefined` | not supported |

`bigint` is the canonical numeric type — TS forces you to write `0n` instead of `0`, which forces you to think about whether you mean "the integer 0" vs "the JS number 0." In Solidity-land all numbers are bigint-equivalent.

### Fixed-width integers

`bigint` is `uint256`. Annotate with `Uint8` … `Uint256` or `Int8` … `Int256` to get a narrower Solidity type. The aliases are branded `bigint`s, so literals need a cast:

```ts
import { Uint8, Uint64 } from "scriipture";

@storage quorum: Uint8 = 51n as Uint8;
@storage votes: Uint64 = 0n as Uint64;

this.votes = (this.votes + 1n) as Uint64;   // → votes = (votes + 1);
```

Adjacent narrow state variables share a storage slot; `scriipture optimize` reports when a different declaration order would save slots.

### Structs and enums

Declare them at file level, next to the contract class. Every contract in the file gets them, emitted inside the contract body.

```ts
export enum Status { Pending, Active, Executed }

export interface Proposal {
  id: bigint;
  proposer: Address;
  votes: Uint64;
  status: Status;
}

export class Governance {
  @storage proposals: Map<bigint, Proposal> = new Map();

  propose(id: bigint): void {
    this.proposals.set(id, { id, proposer: msg.sender, votes: 0n as Uint64, status: Status.Pending });
  }

  vote(id: bigint): void {
    const p = this.proposals.get(id)!;           // → Proposal storage p = proposals[id];
    require(p.status === Status.Pending);
    p.votes = (p.votes + 1n) as Uint64;         // writes through to storage
  }

  @view
  proposalOf(id: bigint): Proposal {            // → returns (Proposal memory)
    return this.proposals.get(id)!;
  }
}
```

What lowers to what:

- An object literal becomes `Proposal({id: id, proposer: msg.sender, …})`. Scriipture takes the struct name from where the literal flows: a typed local, a `return` in a method returning the struct, a state var initializer, a `Map.set` / array `push` on a state var, or an argument to one of the contract's own methods. Anywhere else, write `{ … } as Proposal`. A literal it cannot name is a parse diagnostic.
- A `const p = this.<stateVar>.get(k)` (or `[k]`, or the bare state var) whose type is a struct is emitted as a **storage reference**, so writes through `p` land in storage. Anything else is `memory`.
- Enum members must not have initializers; Solidity numbers them from 0 in declaration order.
- Struct fields must be plain typed properties (no methods, optional fields, index signatures).

### Built-in globals

```ts
import { msg, block } from "scriipture";

msg.sender    // address — caller
msg.value     // bigint  — wei sent with the call
msg.data      // string  — raw calldata

block.timestamp  // bigint
block.number     // bigint
block.coinbase   // Address
block.chainid    // bigint
```

### Cryptographic helpers

```ts
import { keccak256, ecrecover, abi } from "scriipture";

const hash: Bytes32 = keccak256(abi.encode(srcChainId, recipient, amount));
const signer: Address = ecrecover(hash, v, r, s);
```

### Address validation

```ts
import { validate } from "scriipture";

const safe: CheckedAddress = validate(input);   // emits _validateAddr(input): require(input != address(0))
payable(safe).transfer(amount);
```

`CheckedAddress` is a TypeScript brand and is erased in the emitted Solidity; a single `as Address` cast would defeat it. Two things make it real:

- `validate()` lowers to a runtime `require(a != address(0))` helper, so the check exists on-chain.
- The native rule **`require-checked-address`** flags any `Address` parameter (or a local aliasing one) that reaches a `.transfer` / `.send` / `.call` / `.delegatecall` / `.staticcall` target or `pullPayment()` without passing through `validate()` and without being typed `CheckedAddress`. It is a warning in `validate` and an error under `--secure` / `verify`; `@allowZeroAddress("reason")` or `@unsafe("reason")` opts a function out with a recorded justification.

---

## 7. Commands

All commands accept `--help`:

```bash
npx scriipture --help                  # top-level
npx scriipture deploy --help           # subcommand
```

### `init [dir]`

Scaffolds a new Scriipture project in `dir` (default current directory):
- `contracts/Counter.ts` — starter contract
- `scriipture.config.ts` — network and compiler config
- `tsconfig.json` — TS config preconfigured
- `package.json` scripts: `build`, `validate`, `verify`, `compile`, `deploy`
- `.gitignore`

### `build <input>`

Transpiles `.ts` contracts in `<input>` to `.sol` in `out/sol/`. Runs optimizer by default (13 passes); emits:
- `out/sol/<Contract>.sol` — readable, auditable Solidity
- `out/sol-unoptimized/<Contract>.sol` — for diffing
- `out/sol/<Contract>.sourcemap.json` — `.sol:line` → `.ts:line` map
- `out/sol/<Contract>.optimizations.json` — what the optimizer changed

Pass `--no-optimize` to skip optimization (useful for debugging).

The `pack-slots` pass is **advisory**: it reports how many storage slots you would save by declaring state variables in a different order, but never reorders them itself, because reordering rewrites the contract's storage layout (fatal for upgradeable proxies, and the kind of drift the audit tooling exists to flag). Pass `--reorder-storage` to apply the suggested order on a fresh, non-upgradeable contract.

### `validate <input>`

Static checks (16 native rules: tx.origin, selfdestruct, integer division, unbounded loops, low-level call return checking, etc.). Pass `--secure` to escalate footgun warnings to errors unless `@allow-*` decorator is present.

### `optimize <input>`

Reports advisory optimization hints (storage slot packing, storage caching, indexed event params, mapping load reuse) that aren't auto-applied.

### `compile <input>`

Runs solc on `.sol` files. Writes `out/artifacts/<Contract>.json` (ABI + bytecode + deployedBytecode) and `out/artifacts/solc-input.json` (standard JSON input — needed for Etherscan verification).

### `verify <input>`

The 9-gate security pipeline. Runs in order:

1. Native validator (secure mode)
2. solc compile
3. SMTChecker (Z3/CHC engine, proves arithmetic safety)
4. Slither static analysis
5. Pattern library (recognized OZ bases/imports)
6. Auto-generated fuzz harnesses (forge, 1000 runs/method default)
7. Auto-derived invariant tests: forge fuzzing, then an SMTChecker proof attempt per invariant
8. Attestation bundle written to `out/audit/<Contract>/`

Skip individual gates:

```bash
npx scriipture verify contracts --skip fuzz,invariants,patterns
npx scriipture verify contracts --fuzz-runs 5000
```

Every gate result in the attestation carries an explicit `status`: `passed`, `failed`, `skipped`, or `not-applicable` (the gate had nothing to check, e.g. no `@invariant` declared). A skipped gate is recorded as skipped, never as passed, so an auditor can always tell "clean" from "never ran". `passed` is `true` only for `status: "passed"`.

### `gasdiff <input>`

Builds optimized + unoptimized bytecode, compiles each, prints a table of bytecode size deltas.

### `deploy <Contract> -n <network>`

Deploys. Smart defaults:
- If you have a wallet configured (`--wallet name`), uses it.
- Otherwise opens a browser to sign with MetaMask/Rabby/Coinbase Wallet ("browser-wallet flow") — no keys on disk.
- If `etherscan-key` is configured AND network isn't `anvil`, **auto-verifies source on the chain's block explorer** after deploy.
- Override either: `--no-browser`, `--no-verify`.
- Writes `out/deploy-log/<network>/<Contract>.json` for later reference.

```bash
npx scriipture deploy MyToken -n base-sepolia -a 1000000
npx scriipture deploy MyToken -n base -a 1000000 --wallet prod
npx scriipture deploy MyToken -n base-sepolia --no-verify
```

### `secure-deploy <input> -c <Contract> -n <network>`

Full pipeline: runs `verify` (all 9 gates), refuses to deploy unless every gate passes, then deploys. Designed for production where deploy without prior verification is unacceptable.

It also refuses to deploy when any gate was **skipped** (`--no-smt`, `--no-slither`, `--no-fuzz`, `--no-invariants`, `--no-patterns`): an attestation with a hole in it is not an attestation. To ship anyway, say why:

```bash
npx scriipture secure-deploy contracts -c MyToken -n base \
  --no-smt --allow-skipped-gates "SMTChecker times out on MyToken; tracked in issue #42"
```

The justification is recorded on every skipped gate in the attestation bundle, the same way `@unsafe("…")` and `@allow*("…")` justifications are. Mythril (Gate 4) is opt-in via `--deep` and does not need a justification; it is recorded as `skipped` with `optIn: true`.

### `verify-source <Contract> -n <network>`

Submits source to the chain's Etherscan-family explorer via the v2 multichain API. Reads the address + constructor args from the deploy log automatically.

```bash
npx scriipture verify-source MyToken -n base-sepolia
```

### `audit <input>`

Native rules + Slither in one go. Diagnostics remapped to TS line numbers via sourcemap.

### `audit-pack <input>`

Emits a per-contract bundle for auditor handoff:
- `out/audit/<Contract>/`:
  - `<Contract>.ts` (source)
  - `<Contract>.sol` (generated)
  - `<Contract>.sourcemap.json`
  - `<Contract>.audit.md` (human-readable line-mapped report with auto-injected explanations)
  - `<Contract>.slither.json` (full Slither output)
- Zipped to `out/audit/<Contract>.zip`

### `test`

Runs forge against `tests/contracts/*.t.ts` test files. Auto-installs forge-std on first run.

### `trace`

Rewrites forge/solc stack traces from `.sol:line` references to `.ts:line` via the sourcemap. Pipe it any output:

```bash
forge test 2>&1 | npx scriipture trace
```

### `wallet new <name>` / `wallet show <name>` / `wallet list` / `wallet balance <name> -n <network>`

Local hot-wallet management for test-only use. Files stored at `~/.scriipture/wallets/<name>.json` mode 0600.

> ⚠️ Hot wallets are unsafe for production. Use `--browser` (the default for non-anvil deploys without `--wallet`) for any real value.

### `config set/get/list/unset`

User-level config in `~/.scriipture/config.json` mode 0600. Known keys: `etherscan-key`, `default-network`, `default-rpc`.

### `doctor`

Environment check (see [§3](#3-scriipture-doctor)).

---

## 8. The 9-gate security pipeline

`verify` and `secure-deploy` run these gates. Every gate must pass; any failure blocks deploy. Gate 4 (Mythril) is opt-in via `--deep` because symbolic execution is slow (~90s per contract).

| # | Gate | Engine | Catches | Cost |
|---|---|---|---|---|
| 1 | **native-validator** (secure mode) | Scriipture | 16 rules: tx.origin, selfdestruct, low-level call return checks, delegatecall to input, arbitrary call target, zero-address mint, shadowed state, block.timestamp randomness, transfer-in-loop, unbounded loop, integer division, missing visibility, @view mutation, @payable-non-public, constructor-with-decorators | <1s |
| 2 | **solc-compile** | solc 0.8.x | actual syntax/type errors | ~1-2s for typical contracts |
| 3 | **SMTChecker** | native `solc` (Z3/CHC engine) | assertion violations, integer overflow/underflow, division by zero, balance overflow, popEmptyArray, contract-level invariants. Needs a native `solc` on the PATH (`brew install solidity`); the bundled solc-js cannot run Z3, and the gate is then recorded as **skipped**, never as clean | 15s timeout per query |
| **4** | **Mythril** *(opt-in via `--deep`)* | Mythril 0.24+ symbolic execution | deeper paths: reentrancy variants, integer issues across symbolic state, exception-state assertions, dependence on tx.origin, etc. — uses Z3 to explore the symbolic-state tree | ~90s timeout per contract |
| 5 | **Slither** | Slither 0.11+ | 70+ vulnerability detectors — reentrancy, arbitrary-send, dangerous strict equality, locked ether, weak-randomness, … | ~10-30s |
| 6 | **pattern-library** | Scriipture | inherited bases and imports must be from the known-safe list (OpenZeppelin v5, forge-std) | <1s |
| 7 | **fuzz-harness** | forge | auto-generates 1 fuzz test per public method, runs 1000 random inputs each, catches unexpected reverts | depends on `--fuzz-runs` |
| 8 | **invariant-tests** + **invariant-proof** | forge, then native `solc` SMTChecker | `@invariant` decorators emit forge invariant tests (random call sequences — *evidence*, not proof) **and** an SMTChecker harness that asserts each invariant so the CHC engine can try to prove it over every reachable state (*proof*, when the solver finishes). The attestation records, per invariant, proven / unproven / violated | forge: similar to fuzz; SMT: 15s per query |
| 9 | **attestation** | Scriipture | reproducible-build manifest with TS hash, Sol hash, bytecode hash, every tool version, every gate result with an explicit `passed` / `failed` / `skipped` / `not-applicable` status (plus the operator's justification for any skip), canonical-JSON fingerprint | <1s |

### Why Mythril is opt-in

Slither (Gate 5) is pattern-based — fast, broad coverage, ~10-30s. Mythril is symbolic execution — slow (60-300s per contract depending on path explosion), but it explores execution paths Slither can't reason about. For active development you want gates 1-3 + 5-9 on every build. For pre-deploy, pre-audit, or CI cron, add `--deep` to also run Mythril and let Z3 prove assertion safety across symbolic input.

Install Mythril once:

```bash
pipx install mythril                  # cleanest — isolated venv
# or
docker pull mythril/myth              # if your Python is broken or you want isolation
```

Then:

```bash
scriipture verify contracts --deep                       # full 9-gate run, takes minutes
scriipture verify contracts --deep --mythril-timeout 30  # tighter timeout for faster CI
scriipture verify contracts --skip mythril               # explicit opt-out even under --deep
```

### What this catches that hand Solidity misses

In practice, most Solidity bugs that have stolen real money fall into the categories Slither + native rules + SMTChecker detect:
- Reentrancy: Slither
- tx.origin auth: native rule + Slither
- Integer over/underflow: SMTChecker (within solc, with the optimizer enabled in 0.8.x, this is rare anyway)
- Arbitrary send: Slither high severity
- Replay across chains: fuzz harness with mocked source
- Sub-quorum signature acceptance: invariant test (you write one assertion; forge searches for a counterexample and SMTChecker tries to prove there is none)
- Funds sent to an unvalidated address: native rule `require-checked-address` (any `Address` param reaching `.transfer` / `.send` / `.call` / `pullPayment()` must pass `validate()` or be typed `CheckedAddress`)

### What it doesn't catch

- **Trust-model bugs.** "Are 5 of 9 multisig keys compromised?" "Does my validator set have a 67% bribe-resistance margin?" These are economic-security questions, not code.
- **Off-chain validator software bugs.** Most bridge hacks happened in the relayer/oracle off-chain layer.
- **Source-chain reorgs.** Pipeline can verify your on-chain code; it can't replay every possible chain reorg.
- **Novel logic bugs.** Anything that doesn't match a known pattern. Halting Problem applies.

The honest claim: **8 of 10 historical exploit classes** are inside the pipeline's catch radius. The remaining 2 require human judgment and economic-security thinking.

---

## 9. Browser-wallet flow

When you run `deploy <Contract> -n <network>` without `--wallet`, Scriipture:

1. Compiles the contract, encodes the deploy transaction (bytecode + ABI-encoded constructor args)
2. Starts a tiny HTTP server on `http://127.0.0.1:7654/`
3. Opens that URL in your default browser via `open` (macOS), `xdg-open` (Linux), or `start` (Windows)
4. The page checks for `window.ethereum` (MetaMask/Rabby/Coinbase Wallet extension)
5. You click "Connect wallet & deploy" — the extension pops up
6. If you're on the wrong chain, the page prompts a `wallet_switchEthereumChain` (or `wallet_addEthereumChain` if the chain isn't in your wallet)
7. The deploy tx is sent via `eth_sendTransaction` — your extension shows you exactly what you're signing
8. The page POSTs the resulting tx hash back to the CLI
9. The CLI uses viem to wait for the receipt, reads `contractAddress`, prints it

Crucially: **the CLI never sees your private key.** The signature happens entirely in your wallet extension. Your machine's disk never holds the key.

This is the recommended flow for **anything except local Anvil testing**. The local hot-wallet flow (`wallet new`, `--wallet name`) is only for development convenience on testnets you don't care about.

---

## 10. Multi-chain deploy

Built-in networks:

| Network | Chain ID | RPC |
|---|---|---|
| `anvil` | 31337 | http://127.0.0.1:8545 |
| `sepolia` | 11155111 | from viem chain registry |
| `mainnet` | 1 | from viem chain registry |
| `base-sepolia` | 84532 | https://sepolia.base.org |
| `base` | 8453 | https://mainnet.base.org |

Add any chain in `scriipture.config.mjs` — `rpcUrl` and `chainId` are all that's required (`nativeCurrency` and `blockExplorerUrl` are optional):

```js
import { defineConfig } from "scriipture";

export default defineConfig({
  networks: {
    optimism: {
      rpcUrl: "https://mainnet.optimism.io",
      chainId: 10,
    },
    arbitrum: {
      rpcUrl: "https://arb1.arbitrum.io/rpc",
      chainId: 42161,
    },
    polygon: {
      rpcUrl: "https://polygon-rpc.com",
      chainId: 137,
    },
  },
});
```

Then `npx scriipture deploy MyContract -n optimism` just works. Browser-wallet flow handles chain switching automatically — your wallet extension prompts to add the chain if it's not in its list.

---

## 11. Source verification

After deploy, by default Scriipture auto-submits source to the chain's Etherscan-family explorer. This uses Etherscan's **v2 multichain API** — one API key works for every chain (Base, Optimism, Arbitrum, Polygon, ZkSync, Eth mainnet, every testnet).

### One-time setup

```bash
# Register free at https://etherscan.io/myapikey
npx scriipture config set etherscan-key YOUR_KEY
```

### Behavior

- If `etherscan-key` is configured AND network ≠ `anvil`, every `deploy` auto-verifies.
- Override with `--no-verify`.
- Verify retroactively: `npx scriipture verify-source MyToken -n base-sepolia` (reads address + args from the deploy log).
- Or explicitly: `npx scriipture verify-source MyToken -n base-sepolia --address 0x… --args 1000000`.

### What gets submitted

The standard JSON input that solc produced during `compile` — exactly the same input that produced the deployed bytecode. Etherscan re-compiles and confirms the bytecode matches. The result is the green "Verified" checkmark on the explorer's contract page, with your generated Solidity rendered alongside.

---

## 12. Plugins

A plugin can register additional optimizer passes and validator rules:

```ts
// plugins/my-plugin.ts
import type { ScriipturePlugin } from "scriipture";

const plugin: ScriipturePlugin = {
  name: "my-plugin",
  validatorRules: [
    {
      name: "no-todo",
      run: (contract) => {
        const out = [];
        for (const fn of contract.functions) {
          if (fn.natspec?.some((n) => /TODO/.test(n))) {
            out.push({
              rule: "no-todo",
              severity: "warning",
              message: `function "${fn.name}" has a TODO comment`,
              loc: fn.loc,
            });
          }
        }
        return out;
      },
    },
  ],
};

export default plugin;
```

Load it via `scriipture.config.ts`:

```ts
const config: Config = {
  plugins: ["./plugins/my-plugin.ts"],
  // ...
};
```

Diagnostics from plugins show as `plugin:my-plugin/no-todo: …`.

---

## 13. Troubleshooting

| Error | Likely cause | Fix |
|---|---|---|
| `No matching version found for hardhat@^1.x.x` | npm cache issue from an unrelated package | `bun install` instead, or `npm install --legacy-peer-deps` |
| `Module not found: solc/Test.sol` | forge-std not installed | first `scriipture test` run auto-installs it via git clone; otherwise check `out/forge/lib/forge-std/` exists |
| `OwnableUnauthorizedAccount(0x…)` on deploy | you're using OZ v5; the `Ownable` constructor needs an `initialOwner` arg — Scriipture injects `Ownable(msg.sender)` automatically. If you see this error, your contract is doing something unusual; report as a bug |
| `No arguments passed to the base constructor` | a base contract requires constructor args that Scriipture hasn't auto-injected — pass them explicitly via `super(...)` |
| `Error (9553): Invalid type for argument` | TS-only `Number()` or `BigInt()` cast leaked into Solidity. Type your bigint locals with `: bigint` and drop the conversions |
| `slither: command not found` | macOS: `brew install slither-analyzer`; Linux: `pip install slither-analyzer` |
| `forge: command not found` | `curl -L https://foundry.paradigm.xyz \| bash && foundryup` |
| Browser deploy hangs forever | check the browser tab actually opened; if it didn't, copy the URL from the CLI output and paste it manually |
| Etherscan verify returns "Already Verified" | benign — your contract was already verified, often because someone deployed identical bytecode |
| Etherscan verify fails with "Source code is not match" | your local solc version differs from what produced the deployed bytecode. Use `scriipture verify-source <name> -n <network>` with the same compiler version you deployed with |

---

## 14. Comparison

| Capability | Raw Solidity | Hardhat | Foundry | **Scriipture** |
|---|---|---|---|---|
| Compile | solc | hardhat compile | forge build | **scriipture compile** |
| Unit tests | manual | mocha-style JS | Solidity-native | **scriipture test** (TS bridge to forge) |
| Fuzzing | n/a | fuzz plugins | built-in | **auto-generated harnesses** |
| Static analysis | run manually | plugin | bring your own | **gated by default** (Slither + 16 native rules) |
| SMTChecker | flag in solc | flag in solc | flag in solc | **gated by default** |
| Deploy | ethers/viem script | hardhat-deploy | cast/forge | **browser-wallet first-class** |
| Source verification | manual upload to BaseScan | hardhat-verify plugin | forge verify-contract | **auto on every deploy** |
| Reproducible-build manifest | n/a | n/a | partial | **attestation bundle for auditor handoff** |
| Sourcemap to your source | n/a | n/a | maps to Solidity | **maps back to TypeScript** |
| Cross-chain support | manual | per-chain config | per-chain config | **viem multichain + etherscan v2 multichain key** |
| Learning curve | high | medium | medium-high | **none for TS devs** |

If you're already deep in Foundry, Scriipture probably isn't for you — Foundry is more powerful for advanced Solidity work. Scriipture shines for TS devs who want to ship safe contracts without learning a second language and toolchain.

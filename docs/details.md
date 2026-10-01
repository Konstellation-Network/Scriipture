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
- **Reproducible-build attestation** for auditor handoff — hashes, tool versions, every gate's real status, and (after `secure-deploy`) the network, address and tx it cleared. It is a JSON manifest; it is not cryptographically signed or pinned anywhere by Scriipture
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
| `@modifier` | `@modifier onlyKeeper(): void { require(msg.sender === this.keeper); }` | `modifier onlyKeeper() { require(…); _; }` — see [Solidity side by side](#solidity-side-by-side) |
| `@<modifierName>` / `@<modifierName>(args)` | `@onlyKeeper @notBefore(7n * days) sweep() { … }` | `function sweep() public onlyKeeper notBefore(7 days)` — applies a modifier declared with `@modifier` in this contract or a base in the build |
| `@virtual` | `@virtual fee(a: bigint): bigint { … }` | `function fee(…) public virtual …` — only needed for a contract *outside* the build to override it; overrides within the build are inferred |
| `@overload("name")` | `@overload("transfer") transferWithData(to: Address, v: bigint, d: Bytes) { … }` | `function transfer(address to, uint256 v, bytes memory d) …` — a second function of the same Solidity name |
| `@event({ anonymous: true })` | `@event({ anonymous: true }) Moved(…): void {}` | `event Moved(…) anonymous;` |
| `@transient` | `@transient @storage locked!: boolean;` | `bool public transient locked;` (EIP-1153) |
| `@library` (class) | `@library export class MathLib { @pure static max(…) { … } }` | `library MathLib { function max(…) internal pure … }` |
| `@using(Lib)` / `@using<T>(Lib)` (class) | `@using<bigint>(MathLib) export class C { … }` | `using MathLib for uint256;` |
| `@unsafe("reason")` | `@unsafe("legacy contract requires tx.origin")` | annotation only — silences the secure-mode footgun check, recorded in the audit pack |
| `@allowTxOrigin("…")`, `@allowSelfdestruct("…")`, `@allowZeroAddress("…")`, `@allowLowLevelCall("…")` | targeted overrides for specific patterns | bypasses just that one secure-mode rule, with the justification stored in attestation |

A decorator Scriipture does not recognise is an `unknown-decorator` error, on methods and state variables alike. It used to be dropped silently, so a misspelt modifier shipped the function with no access check at all.

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
| `string` (param/local) | `string memory`; `string calldata` when the optimizer can prove the parameter is never written **and** the function is never called from inside the contract (a calldata parameter cannot accept a memory or storage argument) |
| `Uint8` … `Uint256` | `uint8` … `uint256` (any multiple of 8) |
| `Int8` … `Int256` | `int8` … `int256` (any multiple of 8) |
| `Address` | `address` |
| `CheckedAddress` | `address` (compile-time guarantee it's non-zero — see [browser-wallet flow](#9)) |
| `Bytes1` … `Bytes32` | `bytes1` … `bytes32` |
| `Bytes` | `bytes` |
| `Map<K, V>` | `mapping(K => V)` |
| `Array<T>` | `T[]` (storage) / `T[] memory` (memory) |
| `FixedArray<T, N>` | `T[N]` |
| `[bigint, boolean]` (return type) | `returns (uint256, bool)` |
| a contract class or method-only `interface IFoo` | `IFoo` (the contract type) |
| `interface Foo { … }` / `type Foo = { … }` (file level) | `struct Foo { … }` declared inside the contract |
| `enum Foo { A, B }` (file level) | `enum Foo { A, B }` declared inside the contract |
| `void` | (no return) |
| `null` | not supported |
| `undefined` | not supported |

`bigint` is the canonical numeric type — TS forces you to write `0n` instead of `0`, which forces you to think about whether you mean "the integer 0" vs "the JS number 0." In Solidity-land all numbers are bigint-equivalent.

### Visibility

A function is `public` unless you say otherwise. Both spellings work and mean the same thing:

```ts
private helper(v: bigint): bigint { return v * 2n; }   // → function helper(...) private
@private_ other(): void {}                             // → function other() private
```

TypeScript's `private` maps to Solidity `private` and `protected` to `internal`, on fields as well as methods. `public` and `private` are reserved words in TypeScript, so the decorator spellings carry a trailing underscore. A decorator wins over a keyword if you write both.

### What has no Solidity equivalent

These are reported at the line you wrote, rather than dropped or passed through to solc:

| In TypeScript | Why |
|---|---|
| `get x()` / `set x(v)` | Solidity has no accessors; write a method. Dropping them used to remove the only writer of a state variable, after which the optimizer marked it `constant` |
| `f(a?: T)`, `f(a = 1n)`, `f(...xs)` | Solidity has no optional parameters, default arguments or variadics |
| `static`, parameter properties | a contract has no static members |
| `switch`, `for … of`, `for … in`, labelled statements | no equivalent statement; these used to reach solc as TypeScript text |
| `try { … } finally { … }`, or a `try` whose first statement is not an external call | Solidity's `try` wraps exactly one external call or `new` — see [try / catch](#solidity-side-by-side) |
| `[1n, 2n]` (outside a tuple position), `typeof`, `instanceof`, `>>>`, `undefined`, `null`, spreads, arrow functions (outside `unchecked`) | no equivalent expression; these used to reach solc as TypeScript text. An empty `[]` is fine: it is how an array state variable is initialised |
| `Math.max(…)`, `JSON`, `Date`, `Object`, … | JavaScript's standard library does not exist on-chain |
| `throw x` for anything but `new Error("…")` or a declared error | Solidity reverts with a reason string or a custom error, nothing else |
| `extends` a contract that is not in the build | nothing to import |

`break`, `continue` and `do … while` are supported. A base contract, or any other contract or interface in the same build that a contract names, is imported automatically from `./<Name>.sol`.

### Strings

Solidity has no `==` or `+` for `string` and `bytes`, so Scriipture lowers them:

```ts
this.name === other      // → keccak256(bytes(name)) == keccak256(bytes(other))
this.name + suffix       // → string.concat(name, suffix)
```

`bytes` values hash directly and concatenate with `bytes.concat`. Comparing hashes costs gas proportional to length; compare `bytes32` hashes you already store if that matters.

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

### Solidity side by side

Every construct below compiles, and is exercised by `tests/solidity-parity.test.ts`. `tests/contracts/Parity.ts` and `tests/contracts/Advanced.ts` use them together. Both files type-check against these typings and are run on the EVM by forge.

**Contracts and inheritance**

| Solidity | TypeScript |
|---|---|
| `contract C is B` | `export class C extends B` |
| `abstract contract B` / `function f() public virtual returns (uint256);` | `export abstract class B` / `abstract f(): bigint;` (mutability from the doc comment: `/** @view */` — TypeScript forbids decorators on abstract methods) |
| `virtual` / `override` / `override(A, B)` | inferred across the build: `virtual` on a function a derived contract redefines, `override` on the redefinition, the bases listed when several inheritance paths define it. TS `override` forces `override` (for an OpenZeppelin base); `@virtual` forces `virtual` |
| `interface IFoo { function f(address a) external view returns (uint256); }` | `export interface IFoo { /** @view */ f(a: Address): bigint; }` — a file-level interface of methods only. Emitted to `IFoo.sol` when the build uses it; a TS-only shape nothing refers to is not emitted |
| `contract C is IFoo` | `class C implements IFoo` |
| `IFoo(addr).f(a)` | `at<IFoo>(addr).f(a)` — typed, and its result types the local it is assigned to |
| `Child c = new Child(v);` | `const c = new Child(v);` |
| enums / structs shared with a base | declared once, in the base; the derived contract uses the inherited ones |
| `Child c = new Child{salt: s, value: v}(a);` | `const c = create(Child, { salt: s, value: v }, a)` — CREATE2 with `salt`, funded with `value` (which needs a payable constructor: `/** @payable */ constructor(…)`) |
| `library MathLib { function max(…) internal pure … }` | `@library export class MathLib { @pure static max(…) { … } }` — methods are `static` and `internal` unless marked; `static readonly X = …` is a library constant; call as `MathLib.max(a, b)` |
| `using MathLib for *;` / `using MathLib for uint256;` | `@using(MathLib)` / `@using<bigint>(MathLib)` on the class |

**Functions**

| Solidity | TypeScript |
|---|---|
| `receive() external payable { … }` | `receive(): void { … }` |
| `fallback() external [payable] { … }` | `fallback(): void { … }` (with `@payable` for `payable`) |
| `modifier onlyKeeper() { require(…); _; }` | `@modifier onlyKeeper(): void { require(…); }` — `_;` is appended; write `_;` yourself to run code after the body. TypeScript needs the applied name in scope: `declare const onlyKeeper: MethodDecorator;` |
| `function f() … onlyKeeper notBefore(t)` | `@onlyKeeper @notBefore(t) f()` |
| `function claim(uint256 id) … onlyCreator(id)` | `@onlyCreator(param("id")) claim(id: bigint)` — TypeScript evaluates decorator arguments before any call, so the function's own parameter is named with `param("…")`; a name that is not a parameter is an error |
| `returns (uint256, bool)` / `return (a, true);` | `f(): [bigint, boolean]` / `return [a, true];` |
| `(uint256 x, bool ok) = f();` | `const [x, ok] = this.f();` — component types come from `f`'s return type |
| `(a, b) = (b, a);` | `[a, b] = [b, a];` |
| `returns (uint256 amount, bool ok)` | `f(): [amount: bigint, ok: boolean]` — a labelled tuple; `const amount = …` in the body assigns the named return value |
| two functions named `transfer` | `@overload("transfer") transferWithData(…)` — emitted as `transfer`; calls by the TS name are rewritten. TS interfaces declare overloads natively |
| `function (uint256) internal pure returns (uint256) f` | `f: Pure<(a: bigint) => bigint>` — a TS function type is `internal`; `External<F>`, `View<F>`, `Pure<F>`, `Payable<F>` adjust it. Pass `this.g` for an internal one, `at<I>(a).g` for an external one. A function taking an internal function type is `internal` unless marked |
| `function clamp(uint256 v) pure returns (uint256) { … }` at file level | `export function clamp(v: bigint): bigint { … }` at file level — `pure` when it reads nothing from the chain, else tag it `/** @view */` |
| `uint256 constant MAX = 100;` at file level | `const MAX = 100n;` at file level |
| `constructor(…) payable` | `/** @payable */ constructor(…)` — TypeScript forbids decorators on constructors |

**Errors and control flow**

| Solidity | TypeScript |
|---|---|
| `revert TooLow(a, b);` | `revert(this.TooLow(a, b))`, `throw this.TooLow(a, b)` or `throw new TooLow(a, b)` |
| `revert("reason");` | `throw new Error("reason")` or `revert("reason")` |
| `assert(x > 0);` | `assert(x > 0n)` |
| `do { … } while (c);` | `do { … } while (c);` |
| `unchecked { … }` | `unchecked(() => { … })` |
| `try IFoo(t).f() returns (uint256 r) { … } catch { … }` | `try { const r = at<IFoo>(t).f(); … } catch { … }` — the first statement is the call being tried; `return at<IFoo>(t).f()` works too |
| `catch (bytes memory reason) { … }` | `catch (reason) { … }` |
| `catch Error(string memory reason) { … } catch Panic(uint256 code) { … }` | `catch { catchError((reason) => { … }); catchPanic((code) => { … }); … }` — what else the block holds is the catch-all; with no other statements (and no `catch (e)`), any other failure reverts |
| `emit Transfer(a, b, v);` | `emit(this.Transfer(a, b, v))` |
| `event E(…) anonymous;` | `@event({ anonymous: true }) E(…): void {}` — no signature topic, so up to four `Indexed<>` parameters |

**Values and conversions**

| Solidity | TypeScript |
|---|---|
| `uint8(x)` | `x as Uint8` — written only when `x` is known to be a different type, so `(votes + 1n) as Uint64` stays `votes + 1` |
| `uint256(e)` for an enum or narrower int | `BigInt(e)` |
| `type(uint64).max`, `type(IFoo).interfaceId` | `type<Uint64>().max`, `type<IFoo>().interfaceId` |
| `1 ether`, `7 days` | `1n * ether`, `7n * days` (`wei`, `gwei`, `ether`, `seconds`, `minutes`, `hours`, `days`, `weeks`) |
| `bytes4 s = 0xa9059cbb;` | `"0xa9059cbb" as Bytes4` (exactly 2·N hex digits) |
| `hex"deadbeef"` | `"0xdeadbeef" as Bytes` |
| `type Price is uint128;` / `Price.wrap(x)` / `Price.unwrap(p)` | `type Price = ValueType<Uint128, "Price">;` / `wrap<Price>(x)` / `unwrap(p)` — opaque in TS as in Solidity: no arithmetic, no mixing with `Uint128` |
| `bool transient locked;` | `@transient @storage locked!: boolean;` — EIP-1153, reset after every transaction; the file's pragma becomes `^0.8.28` |
| `new uint256[](n)` | `new Array<bigint>(n)` |
| `address(this)` | `address(this)` |
| `a.balance`, `a.code.length`, `a.codehash` | the same |
| `to.call{value: v}(data)` | `to.call({ value: v }, data)` |
| `abi.decode(data, (address, uint256))` | `abi.decode<[Address, bigint]>(data)` |
| `msg.sig`, `tx.gasprice`, `block.basefee`, `block.prevrandao`, `gasleft()`, `blockhash(n)` | the same |

Locals whose type is not written are typed from their initializer. That covers `keccak256` (`bytes32`), comparisons (`bool`), `abi.encode` (`bytes memory`), calls into other contracts and interfaces in the build, and `new`. Previously anything unknown fell back to `uint256`.

**Where things go.** A free function, a file-level constant, and any struct, enum or value type that a library, an interface, a free function or a constant uses are emitted to `<file>.defs.sol`, which every contract, library and interface from that TypeScript file imports. Other structs and enums stay inside each contract, as before.

**A parameter named like a state variable** (`constructor(owner: Address) { this.owner = owner; }`) is emitted as `owner_`, because Solidity would read both sides of `owner = owner` as the parameter. The `no-shadowed-state` warning still points it out.

**No Solidity counterpart**, and reported at your line rather than miscompiled: `null` / `undefined`, optional and default parameters, rest parameters, rest / default / nested destructuring, `switch`, `for … of`, getters and setters, `finally`, JavaScript's standard library (`Math`, `JSON`, …), and `public` / `external` library functions (Scriipture does not link libraries; their functions are internal).

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

`build` runs the validator first and writes nothing if it reports an error. Some constructs can only be emitted by guessing — a `?? fallback` whose left-hand type cannot be inferred, a destructuring with no known shape — and a guess produces a contract that compiles but is not the program you wrote. Pass `--no-validate` to emit anyway.

The `pack-slots` pass is **advisory**: it reports how many storage slots you would save by declaring state variables in a different order, but never reorders them itself, because reordering rewrites the contract's storage layout (fatal for upgradeable proxies, and the kind of drift the audit tooling exists to flag). Pass `--reorder-storage` to apply the suggested order on a fresh, non-upgradeable contract.

### `validate <input>`

Static checks (28 native rules: tx.origin, selfdestruct, integer division, unbounded loops, low-level call return checking, etc.). Pass `--secure` to escalate footgun warnings to errors unless `@allow-*` decorator is present.

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

Every gate result in the attestation carries an explicit `status`: `passed`, `failed`, `skipped`, or `not-applicable` (the gate had nothing to check, e.g. no `@invariant` declared, or no method with fuzzable parameters). A skipped gate is recorded as skipped, never as passed, so an auditor can always tell "clean" from "never ran". `passed` is `true` only for `status: "passed"`. Gates that depend on an external engine also record `engine`, e.g. `"native-solc 0.8.37+commit.f401782d"`, because two solc builds of the same version differ in whether they can run the SMTChecker at all.

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

It also refuses to deploy when any gate was **skipped**: an attestation with a hole in it is not an attestation. That covers the `--no-*` flags, and equally a gate that could not run — most often gates 3 and 8 on a machine with no solc built with a Horn solver. To ship anyway, say why:

```bash
npx scriipture secure-deploy contracts -c MyToken -n base \
  --no-smt --allow-skipped-gates "SMTChecker times out on MyToken; tracked in issue #42"
```

The justification is recorded on every skipped gate in the attestation bundle, the same way `@unsafe("…")` and `@allow*("…")` justifications are. Mythril (Gate 4) is opt-in via `--deep` and does not need a justification; it is recorded as `skipped` with `optIn: true`.

**What is deployed is what was verified.** Gate 2 writes the artifacts it compiled to `out/artifacts/`, and `secure-deploy` deploys from there rather than from whatever `scriipture compile` last left on disk. After the transaction is mined it rewrites the contract's attestation with a `deployment` record and prints the new fingerprint, so the gate results are tied to the address they cleared:

| Field | Meaning |
|---|---|
| `network`, `address`, `txHash`, `from`, `deployedAt` | where it went |
| `artifactDeployedBytecode` | sha256 of the bytecode actually sent — **must** equal `hashes.deployedBytecode`, or `secure-deploy` refuses to stamp and exits non-zero |
| `onchainDeployedBytecode` | sha256 of `eth_getCode(address)` after the deploy, when the node could be reached |
| `onchainMatchesArtifact` | whether those two agree. `false` is normal for a contract with immutables or linked libraries, since those are substituted at construction; both hashes are recorded either way |

Without that binding an attestation could assert that audited source lives at an address whose code nobody compared — a stale `out/artifacts/` file is enough to make it false. `secure-deploy` accepts the same `--skip`, `--fuzz-runs`, `--mythril-timeout` and `--deep` flags as `verify`.

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
| 1 | **native-validator** (secure mode) | Scriipture | 28 rules: tx.origin, selfdestruct, low-level call return checks, delegatecall to input, arbitrary call target, zero-address mint, shadowed state, block.timestamp randomness, transfer-in-loop, unbounded loop, integer division, missing visibility, @view mutation, @payable-non-public, constructor-with-decorators | <1s |
| 2 | **solc-compile** | solc 0.8.x | actual syntax/type errors | ~1-2s for typical contracts |
| 3 | **SMTChecker** | native `solc` **built with a Horn solver** | assertion violations, integer overflow/underflow, division by zero, balance overflow, popEmptyArray, contract-level invariants. See [Getting a solc that can actually run it](#smt-solver) — without one the gate is recorded as **skipped**, never as clean | 15s timeout per query |
| **4** | **Mythril** *(opt-in via `--deep`)* | Mythril 0.24+ symbolic execution | deeper paths: reentrancy variants, integer issues across symbolic state, exception-state assertions, dependence on tx.origin, etc. — uses Z3 to explore the symbolic-state tree | ~90s timeout per contract |
| 5 | **Slither** | Slither 0.11+ | 70+ vulnerability detectors — reentrancy, arbitrary-send, dangerous strict equality, locked ether, weak-randomness, … | ~10-30s |
| 6 | **pattern-library** | Scriipture | inherited bases and imports must be from the known-safe list (OpenZeppelin v5, forge-std) | <1s |
| 7 | **fuzz-harness** | forge | auto-generates 1 fuzz test per public method, runs 1000 random inputs each, catches unexpected reverts | depends on `--fuzz-runs` |
| 8 | **invariant-tests** + **invariant-proof** | forge, then native `solc` SMTChecker | `@invariant` decorators emit forge invariant tests (random call sequences — *evidence*, not proof) **and** an SMTChecker harness that asserts each invariant so the CHC engine can try to prove it over every reachable state (*proof*, when the solver finishes). The attestation records, per invariant, proven / unproven / violated. A run where the solver settled **nothing** is recorded as `skipped`, not `passed`: an auditor reads `passed` as *proved* | forge: similar to fuzz; SMT: 15s per query |
| 9 | **attestation** | Scriipture | reproducible-build manifest with TS hash, Sol hash, bytecode hash, every tool version, every gate result with an explicit `passed` / `failed` / `skipped` / `not-applicable` status (plus the operator's justification for any skip), canonical-JSON fingerprint | <1s |

<a id="smt-solver"></a>
### Getting a solc that can actually run the SMTChecker

Gate 3 and the invariant proof stage need a `solc` on your PATH that was built with a Horn solver (Z3 or Eldarica). **Two builds reporting the same version differ on this**, so `solc --version` does not answer the question — and the bundled `solc-js` cannot start a solver at all, so a native binary is always required.

Ask the tool, which compiles a throwaway contract through the model checker and reports what happened:

```bash
scriipture doctor
# SMTChecker (gates 3 and 8) — needs a solc built with a Horn solver
#   ✓ native-solc 0.8.37+commit.f401782d
# …or…
#   ✗ CHC analysis was not possible since no Horn solver was found and enabled.
```

Known: the official `solc-macos` release binary is built without Z3, so installing "the latest solc" is not enough. Distribution packages built with `-DUSE_Z3=ON` and the `ethereum/solc` Docker images are the usual way to get one; verify with `scriipture doctor` rather than by version number.

Scriipture never guesses. When solc reports `7649 CHC analysis was not possible since no Horn solver was found and enabled` or `8158 Solver z3 was selected for SMTChecker but it is not available`, when the process crashes or is killed, or when solc-js fails to start its thread, the gate is recorded as `skipped` with that reason and the engine that was tried — not as `0 findings`.

Because SMTChecker reports every finding through solc's *warning* channel and never its *error* channel, Scriipture reads the verdict from the message rather than the severity: `… happens here` is a counterexample the solver found, `… might happen here` is a property it could not settle and is recorded as unproved.

What blocks, and what is only reported:

| Finding | Gate 3 |
|---|---|
| a proven **assertion violation** (`assert` can fail, which is what a generated `@invariant` harness asserts) | **fails** |
| a proven **arithmetic** issue — overflow, underflow, division by zero, popping an empty array | reported, does not fail: under Solidity 0.8 these revert rather than corrupt state |
| anything the solver could not settle (`might happen here`) | reported as unproved |

Every finding is written to the attestation with its `kind` and `severity`, so an auditor can apply a stricter policy than the gate does.

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
| `optimism` | 10 | https://mainnet.optimism.io |
| `optimism-sepolia` | 11155420 | https://sepolia.optimism.io |
| `arbitrum` | 42161 | https://arb1.arbitrum.io/rpc |
| `arbitrum-sepolia` | 421614 | https://sepolia-rollup.arbitrum.io/rpc |
| `polygon` | 137 | from viem chain registry |
| `polygon-amoy` | 80002 | https://rpc-amoy.polygon.technology |

Add any chain in `scriipture.config.mjs` — `rpcUrl` and `chainId` are all that's required (`nativeCurrency` and `blockExplorerUrl` are optional):

```js
import { defineConfig } from "scriipture";

export default defineConfig({
  networks: {
    linea: {
      rpcUrl: "https://rpc.linea.build",
      chainId: 59144,
    },
    scroll: {
      rpcUrl: "https://rpc.scroll.io",
      chainId: 534352,
      blockExplorerUrl: "https://scrollscan.com",
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

A plugin that gives meaning to its own decorators lists them in `decorators: ["audited", …]`; otherwise the `unknown-decorator` rule reports them, since Scriipture would drop them from the emitted Solidity.


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
| Static analysis | run manually | plugin | bring your own | **gated by default** (Slither + 28 native rules) |
| SMTChecker | flag in solc | flag in solc | flag in solc | **gated by default** |
| Deploy | ethers/viem script | hardhat-deploy | cast/forge | **browser-wallet first-class** |
| Source verification | manual upload to BaseScan | hardhat-verify plugin | forge verify-contract | **auto on every deploy** |
| Reproducible-build manifest | n/a | n/a | partial | **attestation bundle for auditor handoff** |
| Sourcemap to your source | n/a | n/a | maps to Solidity | **maps back to TypeScript** |
| Cross-chain support | manual | per-chain config | per-chain config | **viem multichain + etherscan v2 multichain key** |
| Learning curve | high | medium | medium-high | **none for TS devs** |

If you're already deep in Foundry, Scriipture probably isn't for you — Foundry is more powerful for advanced Solidity work. Scriipture shines for TS devs who want to ship safe contracts without learning a second language and toolchain.

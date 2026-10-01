# Scriipture

**Write smart contracts in TypeScript. Ship auditable Solidity.**

[![npm](https://img.shields.io/npm/v/scriipture.svg)](https://www.npmjs.com/package/scriipture)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

You already know TypeScript. Scriipture turns it into Solidity a human can read and an auditor can sign off on — then refuses to deploy until nine security gates pass.

```bash
npm install scriipture
```

---

## What you write, and what actually ships

**Your TypeScript:**

```ts
import { storage, view, onlyOwner } from "scriipture";

export class Counter {
  @storage count: bigint = 0n;

  @onlyOwner
  increment(): void {
    require(this.count < 1000000n, "Max reached");
    this.count = this.count + 1n;
  }

  @view
  current(): bigint {
    return this.count;
  }
}
```

**The Solidity Scriipture emits:**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

contract Counter is Ownable {
    error MaxReached();

    uint256 public count;

    constructor() Ownable(msg.sender) {}

    function increment() public onlyOwner {
        if (!(count < 1000000)) {
            revert MaxReached();
        }
        count = count + 1;
    }

    function current() public view returns (uint256) {
        return count;
    }
}
```

That output is real, not illustrative — it's what `scriipture build` produces from the file above. Along the way it inferred the `Ownable` base and injected `Ownable(msg.sender)`, rewrote the string `require` into a custom error (~50 gas cheaper per revert, smaller bytecode), and dropped the redundant `= 0` initializer.

**You ship Solidity, not a black box.** The `.sol` is the artifact. Read it, diff it, hand it to an auditor.

### A fuller one: events, an interface, a modifier, custom errors

```ts
import { Address, Indexed, storage, view, modifier, event, error, msg, emit, at, require } from "scriipture";

declare const onlyAdmin: MethodDecorator;

export interface IERC20 {
  transfer(to: Address, amount: bigint): boolean;
}

export class Tips {
  @storage admin: Address;
  @storage tipped: Map<Address, bigint> = new Map();

  @event Tipped(from: Indexed<Address>, to: Indexed<Address>, amount: bigint): void {}
  @error ZeroTip(): void {}

  constructor() {
    this.admin = msg.sender;
  }

  @modifier
  onlyAdmin(): void {
    require(msg.sender === this.admin, "not admin");
  }

  tip(token: Address, to: Address, amount: bigint): void {
    if (amount === 0n) throw this.ZeroTip();
    require(at<IERC20>(token).transfer(to, amount), "transfer failed");
    this.tipped.set(to, (this.tipped.get(to) ?? 0n) + amount);
    emit(this.Tipped(msg.sender, to, amount));
  }

  @view
  totalFor(who: Address): bigint {
    return this.tipped.get(who) ?? 0n;
  }

  @onlyAdmin
  handOver(next: Address): void {
    this.admin = next;
  }
}
```

**Emits** `Tips.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IERC20.sol";

contract Tips {
    error ZeroTip();
    error NotAdmin();
    error TransferFailed();

    event Tipped(address indexed from, address indexed to, uint256 amount);

    address public admin;
    mapping(address => uint256) public tipped;

    constructor() {
        admin = msg.sender;
    }

    modifier onlyAdmin() {
        if (!(msg.sender == admin)) {
            revert NotAdmin();
        }
        _;
    }

    function tip(address token, address to, uint256 amount) public {
        if (amount == 0) {
            revert ZeroTip();
        }
        if (!IERC20(token).transfer(to, amount)) {
            revert TransferFailed();
        }
        tipped[to] = tipped[to] + amount;
        emit Tipped(msg.sender, to, amount);
    }

    function totalFor(address who) public view returns (uint256) {
        return tipped[who];
    }

    function handOver(address next) public onlyAdmin {
        admin = next;
    }
}
```

and, because `Tips` calls it through `at<IERC20>(…)`, `IERC20.sol` beside it:

```solidity
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}
```

Every event is declared and emitted exactly as written. `Indexed<T>` becomes an `indexed` topic, and an event declared in a base contract can be emitted from a derived one. `throw this.ZeroTip()` is `revert ZeroTip();`, and the string `require`s became custom errors on the way out.

### TypeScript ↔ Solidity at a glance

| You write | Scriipture emits |
|---|---|
| `@event Tipped(from: Indexed<Address>, amount: bigint): void {}` | `event Tipped(address indexed from, uint256 amount);` |
| `emit(this.Tipped(msg.sender, amount))` | `emit Tipped(msg.sender, amount);` |
| `@error TooLow(have: bigint): void {}` / `throw this.TooLow(x)` | `error TooLow(uint256 have);` / `revert TooLow(x);` |
| `export interface IERC20 { … }` + `at<IERC20>(t).transfer(to, v)` | `interface IERC20 { … }` + `IERC20(t).transfer(to, v)` |
| `class Vault extends Base implements IVault` | `contract Vault is IVault, Base` |
| `abstract class Base` / `abstract fee(a: bigint): bigint;` | `abstract contract Base` / `function fee(uint256 a) public virtual returns (uint256);` |
| a method redefined in a derived class | `virtual` on the base, `override` on the derived (inferred) |
| `@modifier onlyAdmin(): void { … }` + `@onlyAdmin f()` | `modifier onlyAdmin() { …; _; }` + `function f() public onlyAdmin` |
| `receive(): void { … }` / `fallback(): void { … }` | `receive() external payable { … }` / `fallback() external { … }` |
| `f(): [bigint, boolean]` / `return [a, true]` / `const [x, ok] = this.f()` | `returns (uint256, bool)` / `return (a, true);` / `(uint256 x, bool ok) = f();` |
| `try { const b = at<IERC20>(t).balanceOf(a); … } catch { … }` | `try IERC20(t).balanceOf(a) returns (uint256 b) { … } catch { … }` |
| `do { … } while (c)` / `unchecked(() => { … })` | `do { … } while (c);` / `unchecked { … }` |
| `Map<Address, bigint>` / `FixedArray<bigint, 3>` / `new Array<bigint>(n)` | `mapping(address => uint256)` / `uint256[3]` / `new uint256[](n)` |
| `x as Uint8` / `BigInt(status)` / `type<Uint64>().max` | `uint8(x)` / `uint256(status)` / `type(uint64).max` |
| `2n * ether` / `7n * days` / `"0xa9059cbb" as Bytes4` | `2 ether` / `7 days` / `0xa9059cbb` |
| `to.call({ value: v }, data)` / `abi.decode<[Address, bigint]>(data)` | `to.call{value: v}(data)` / `abi.decode(data, (address, uint256))` |

The complete mapping, including what is not supported yet (libraries, function types, overloading, …), is in [docs/details.md — Solidity side by side](./docs/details.md#solidity-side-by-side). Anything with no Solidity counterpart, such as `switch`, `Math.max` or a decorator Scriipture doesn't know, is reported at your line instead of being dropped or passed through to solc.

---

## Quickstart

```bash
npm install scriipture
npx scriipture doctor --fix
npx scriipture init my-token && cd my-token
```

`doctor --fix` is a one-time setup that fetches the toolchain — Foundry binaries, and Slither/Mythril Docker images. solc and OpenZeppelin v5 are already bundled in the npm install, so a plain `build` works with no setup at all.

Then the loop:

```bash
npx scriipture build contracts      # TypeScript → Solidity
npx scriipture verify contracts     # 9-gate security pipeline
npx scriipture compile out/sol      # → ABI + bytecode
npx scriipture deploy Counter -n base-sepolia
```

The last command opens your browser. MetaMask, Rabby, or Coinbase Wallet pops up, you sign, and the contract goes live — **no private key ever touches disk.**

---

## Why Scriipture

**No Solidity required.** Write in the language and types you already use. What comes out the other side is readable Solidity, not bytecode.

**Solidity, construct for construct.** Interfaces, abstract contracts, `virtual` / `override`, modifiers, `receive` / `fallback`, tuples, `try` / `catch`, `unchecked`, custom errors, units and explicit conversions all have a TypeScript spelling that type-checks, and a construct with no Solidity counterpart is an error at your line rather than a surprise from solc. The full mapping is in [docs/details.md — Solidity side by side](./docs/details.md#solidity-side-by-side).

**Nine verifiers gate every deploy.** `secure-deploy` refuses to ship unless all of them pass. Security is the default, not a plugin you remember to install.

**Private keys stay off disk.** The CLI opens a local bridge and you sign in your browser wallet, exactly like any web app. Local hot wallets are available when you want them, but they're opt-in.

**One `npm install`.** No Python, no Rust, no `foundryup`. OpenZeppelin v5 and solc ship with the package; everything else is lazy-fetched on first use.

**Stack traces point at your TypeScript.** When forge throws, `scriipture trace` rewrites every `.sol:line` back to the `.ts:line` it came from.

**Nothing phones home.** Zero telemetry, zero analytics. The CLI runs entirely on your machine.

---

## The 9-gate pipeline

`scriipture verify` runs these in order. Any failure blocks the deploy.

| # | Gate | Catches |
|---|---|---|
| 1 | Native validator | `tx.origin` auth, `selfdestruct`, `delegatecall` to input, zero-address mint, unsafe division — 27 rules |
| 2 | solc | syntax and type errors |
| 3 | SMTChecker | overflow, underflow, division-by-zero, assertion violations — needs a native `solc` built with a Horn solver (`scriipture doctor` tells you whether yours is; the version number does not). Recorded as skipped, never as clean, when no solver can run |
| 4 | Mythril | symbolic execution (opt-in via `--deep`) |
| 5 | Slither | 70+ vulnerability detectors |
| 6 | Pattern library | only known-safe OpenZeppelin v5 and forge-std imports allowed |
| 7 | Fuzz harnesses | auto-generated, 1000 random inputs per public method |
| 8 | Invariant tests | `@invariant` decorators → forge invariant fuzzing (evidence) **and** an SMTChecker proof attempt per invariant (proven / unproven / violated in the attestation) |
| 9 | Attestation | reproducible-build manifest recording every tool version and every gate's real status; `secure-deploy` stamps the network, address and tx onto it after deploy |

Skip individual gates while iterating with `--skip fuzz,invariants`.

---

## Networks

```bash
scriipture deploy MyToken -n base-sepolia
```

| Network | Flag |
|---|---|
| Base | `base` |
| Base Sepolia | `base-sepolia` |
| Ethereum | `mainnet` |
| Sepolia | `sepolia` |
| Local Anvil | `anvil` |

Deployed contracts auto-verify on the matching Etherscan-family explorer when an API key is configured.

> More EVM chains are on the roadmap. Today these five are what `deploy` accepts — anything else exits with `Unknown network`.

---

## Commands

| Command | Does |
|---|---|
| `doctor [--fix]` | Check the environment; `--fix` installs what's missing |
| `init [dir]` | Scaffold a project — contracts, config, tsconfig, scripts |
| `build <input>` | Transpile TypeScript → Solidity (optimizer on by default) |
| `validate <input>` | Static checks, 27 native rules |
| `verify <input>` | The full 9-gate pipeline |
| `compile <input>` | solc → ABI + bytecode |
| `deploy <Contract> -n <net>` | Deploy via browser wallet, auto-verify source |
| `secure-deploy <input>` | Deploy only if all 9 gates pass |
| `audit <input>` | Native rules + Slither |
| `audit-pack <input>` | Per-contract bundle for auditor handoff |
| `gasdiff <input>` | Bytecode size, unoptimized vs optimized |
| `test` | Forge tests plus generated fuzz |
| `trace` | Rewrite `.sol:line` → `.ts:line` in stack traces |

Full flags for every command: [docs/cli-commands.yaml](./docs/cli-commands.yaml).

---

## Use it as a library

The compiler is a normal TypeScript module — the CLI is just one consumer.

```ts
import {
  parseContractFiles,
  optimizeProgram,
  emitProgram,
} from "scriipture";

const { program } = parseContractFiles(["./contracts/MyToken.ts"]);
optimizeProgram(program);
const [{ solidity }] = emitProgram(program);
console.log(solidity);
```

`emitProgram` returns one file per contract, in declaration order, followed by one per interface the contracts use (`kind: "interface"`). Write them all side by side, because a contract imports its interfaces from `./<Name>.sol`.

---

<details>
<summary><strong>What's bundled vs fetched on demand</strong></summary>

| Tool | Where it comes from |
|---|---|
| solc (JS) | bundled — works immediately |
| @openzeppelin/contracts | bundled as a regular dependency |
| TypeScript parser, viem | bundled |
| forge + anvil | auto-downloaded on first use, or by `doctor --fix`, from Foundry's official release for your platform |
| Slither | Docker (`trailofbits/eth-security-toolbox`), falling back to a native `slither` on PATH |
| Mythril | Docker (`mythril/myth`), falling back to a native `myth` on PATH |

Docker is the smoothest path for Slither and Mythril — it means never touching Python. Without it, both fall back to binaries on your PATH.

</details>

---

## Documentation

- **[docs/details.md](./docs/details.md)** — the full user guide, written for developers who have never shipped Solidity
- **[docs/cli-commands.yaml](./docs/cli-commands.yaml)** — every command and flag, machine-readable
- **[docs/openapi.yaml](./docs/openapi.yaml)** — OpenAPI spec for the browser-deploy surface
- **TypeDoc reference** for the library API — generate it locally with `bun run docs:typedoc`

## Contributing

Issues and pull requests welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). Security reports go through [SECURITY.md](./SECURITY.md).

## License

MIT — see [LICENSE](./LICENSE).

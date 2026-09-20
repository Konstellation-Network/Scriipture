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
| 1 | Native validator | `tx.origin` auth, `selfdestruct`, `delegatecall` to input, zero-address mint, unsafe division — 19 rules |
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
| `validate <input>` | Static checks, 18 native rules |
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

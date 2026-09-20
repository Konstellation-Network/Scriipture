# Scriipture — Landing page content

> This file is structured content for the marketing site, not a doc.
> Each `##` section is intended as a separate page block. Code blocks are copy-paste-ready.

---

## Hero

**Write smart contracts in TypeScript. Ship audited Solidity.**

Multi-chain deploy + 9-gate security pipeline + browser-wallet signing — all from `npm install scriipture`.

```ts
import { Address, onlyOwner, msg } from "scriipture";
import { ERC20 } from "scriipture/standards";

export class MyToken extends ERC20 {
  constructor(supply: bigint) {
    super("MyToken", "MTK");
    this._mint(msg.sender, supply);
  }

  @onlyOwner
  mint(to: Address, amount: bigint): void {
    this._mint(to, amount);
  }
}
```

**Primary CTA:** `Get started` → `/docs`
**Secondary CTA:** `View on GitHub` → `https://github.com/Worldstreet-Web-Services/scripture`

---

## 60-second quickstart

Two commands. From empty directory to verified contract on Base Sepolia.

```bash
# 1. Install
npm install scriipture

# 2. Auto-fetch the toolchain (forge, anvil, slither, mythril — all of it)
npx scriipture doctor --fix

# 3. Scaffold a project
npx scriipture init my-token && cd my-token

# 4. Deploy via your browser wallet — no private keys on disk
npx scriipture deploy Counter -n base-sepolia
```

A browser tab opens. MetaMask pops up. You sign. The contract is live + auto-verified on BaseScan.

---

## Why Scriipture

**Zero Solidity required.** Write in TypeScript with the types you already know. The transpiler emits readable, auditable Solidity — not bytecode.

**9 verifiers gate every deploy.** Native validator → solc → SMTChecker (Z3) → Mythril → Slither → pattern library → forge fuzz → invariant tests → reproducible-build attestation. Refuses to deploy until every gate passes.

**Browser-wallet signing.** Private keys never touch disk. The CLI starts a local bridge; you sign in MetaMask/Rabby/Coinbase Wallet exactly like a web app.

**One npm install, no Python, no Rust, no Foundryup.** OpenZeppelin v5 is bundled. `doctor --fix` lazy-fetches Foundry binaries and pulls Slither/Mythril Docker images on first use.

**Auto-verify on deploy.** One Etherscan v2 API key covers every network Scriipture deploys to — Base, Ethereum, and their testnets. Source lands verified on the explorer without a second command.

**Source maps back to your TypeScript.** When forge throws a stack trace, `scriipture trace` rewrites every `.sol:line` to the originating `.ts:line`.

---

## What you write vs what ships

Side-by-side. Your code on the left, the audited Solidity Scriipture generates on the right.

**TypeScript (yours):**

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

**Solidity (generated):**

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

**What Scriipture did automatically:**
- inferred `Ownable` base + injected `Ownable(msg.sender)` constructor call
- rewrote `require("…")` → custom error (saves ~50 gas per revert + shrinks bytecode)
- inferred `count` defaults to 0 + stripped the redundant initializer

---

## The 9-gate security pipeline

Every `scriipture verify` runs in order. Any gate fails → deploy is blocked.

| Gate | Tool | What it catches |
|---|---|---|
| 1 | Native validator | `tx.origin`, `selfdestruct`, `delegatecall` to input, zero-address mint, integer division (26 rules) |
| 2 | solc | syntax + type errors |
| 3 | SMTChecker | overflow / underflow / division-by-zero / assertion violations (Z3-backed proofs) |
| 4 | Mythril | symbolic execution — opt-in via `--deep` |
| 5 | Slither | 70+ vulnerability detectors |
| 6 | Pattern library | only known-safe OpenZeppelin v5 bases & forge-std imports allowed |
| 7 | Auto-generated fuzz | 1000 random inputs per public method, forge-powered |
| 8 | Invariant tests | `@invariant` decorators → forge invariant tests across 128k random state transitions |
| 9 | Attestation bundle | reproducible-build manifest recording every tool version, every gate's status, and the deployment it cleared |

---

## One toolchain, every supported network

Same command, same flow, whichever network you target.

`base` · `base-sepolia` · `mainnet` · `sepolia` · `anvil`

```bash
scriipture deploy MyToken -n base                # Base mainnet
scriipture deploy MyToken -n base-sepolia        # Base testnet
scriipture deploy MyToken -n anvil               # local
```

Deployed contracts auto-verify on the matching Etherscan-family explorer when an API key is configured. More EVM networks are on the roadmap — anything outside the list above currently exits with `Unknown network`.

---

## Scriipture vs the alternatives

| | Raw Solidity | Hardhat | Foundry | **Scriipture** |
|---|---|---|---|---|
| Learning curve | high | medium | medium-high | **none for TS devs** |
| Static analysis | opt-in | plugin | bring your own | **gated by default** |
| Auto-fuzz harnesses | n/a | manual | manual | **auto-generated** |
| Deploy auth | private key | private key | private key | **browser wallet first-class** |
| Source verification | manual | plugin | plugin | **automatic on every deploy** |
| Reproducible-build manifest | n/a | n/a | partial | **per-contract attestation** |

---

## Library API (programmatic)

Use Scriipture as a library, not just a CLI.

```ts
import {
  parseContractFiles,
  emitProgram,
  validateProgram,
  optimizeProgram,
  compileSolidity,
} from "scriipture";

const { program } = parseContractFiles(["./contracts/MyToken.ts"]);
optimizeProgram(program);
const [{ solidity }] = emitProgram(program);
console.log(solidity);
```

---

## Trust signals (for the page)

- MIT licensed
- 100% open source on GitHub
- Built on OpenZeppelin v5, solc, Slither, Mythril, Foundry — every battle-tested tool in the EVM ecosystem
- Reproducible builds: same TS source + same Scriipture version = byte-identical Solidity output
- Zero telemetry, zero analytics, zero phone-home — the CLI runs entirely on your machine

---

## Final CTA

**Ship safer contracts in TypeScript.**

```bash
npm install scriipture
```

`Get started` → `/docs` · `Star on GitHub` → `https://github.com/Worldstreet-Web-Services/scripture` · `Read the docs` → `/docs/details`

---

## Footer

- **GitHub** — github.com/Worldstreet-Web-Services/scripture
- **npm** — npmjs.com/package/scriipture
- **Docs** — full reference in [docs/details.md](./docs/details.md)
- **License** — MIT

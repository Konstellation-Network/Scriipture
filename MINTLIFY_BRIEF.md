# Scriipture docs site — Mintlify setup brief

> Hand this whole file to the engineer setting up Mintlify on the landing page repo. It's self-contained: context, goal, content sources, structure, setup steps, theming, deployment, sync strategy.
>
> Works as a human brief or as a prompt for an AI coding assistant (Cursor, Claude Code, etc.).

---

## Context: what Scriipture is

Scriipture is a TypeScript → Solidity transpiler with a built-in 9-gate security pipeline. Developers write smart contracts in TS, Scriipture transpiles them to auditable Solidity, runs security analysis, and deploys to any EVM chain. Source-of-truth is at https://github.com/Worldstreet-Web-Services/scripture (MIT, public).

Already shipped as an npm package: `npm install scriipture`. We need a docs site for it.

## Goal

Add Mintlify-powered docs to the **landing page repo** (this repo, where the marketing site already lives). Docs render at `/docs/*` or at a `docs.` subdomain — whichever fits the existing site architecture.

The content is being handed over from Scriipture's repo as a set of source files; you'll convert it into Mintlify's MDX format, wire up the navigation, theme it to match the marketing brand, and deploy.

## Important framing

**This is package-usage documentation, not API reference.** Scriipture is a CLI tool and a TypeScript library — users invoke it via `npx scriipture ...` or `import { … } from "scriipture"`. There is no HTTP service for end users to call. Treat this exactly like the docs for a typical npm dev tool (think: Vite docs, viem docs, Prisma CLI docs) — install, concepts, commands, library API, guides. Do not set up an "API Reference" tab with OpenAPI; we have no public HTTP API.

## What you're being given

The maintainer is sharing the following from the Scriipture repo (paths preserved for reference; copy them to the appropriate Mintlify location in this repo):

- `docs/details.md` — the comprehensive 14-section user guide. This is the bulk of the docs content. You'll split it into separate MDX pages.
- `docs/cli-commands.yaml` — machine-readable manifest of every CLI subcommand and flag. Useful as a quick reference; can become a single "All commands" overview page, or skipped entirely if the per-command pages already cover it.
- `README.md` — short README from the repo (install + 60-second quickstart). Source for the "Introduction" and "Quickstart" pages.
- `LANDING.md` — marketing-page content blocks. **This is not docs.** Meant for hero/section blocks on the marketing homepage. Mentioned here so you don't accidentally put it in the docs site.
- `CHANGELOG.md` — release history in Keep-a-Changelog format. Source for a "Changelog" page (optional).
- `examples/*/` — eight example contracts in TypeScript. Source code samples to embed throughout the docs. Use Mintlify's `<CodeGroup>` to show TS + generated Solidity side-by-side where useful.
- `types/` — TypeScript ambient definitions. Source for the "Library API" reference page.
- `package.json` — current version, license, entry points.

`docs/openapi.yaml` exists in the source repo as an internal spec for the local browser-deploy bridge (a `localhost:7654` HTTP server the CLI spawns for ~30 seconds during a wallet-signed deploy). **It is not user-facing API material.** Do not include it in the Mintlify site.

## Proposed site structure

```
docs/
├─ introduction          (the "what is Scriipture" + value props)
├─ install               (npm install + doctor --fix flow)
├─ quickstart            (60-second walkthrough — token deployed to Base Sepolia)
│
├─ concepts/
│  ├─ decorators         (every @storage, @view, @onlyOwner, etc., with TS→Sol side-by-side)
│  ├─ type-mapping       (bigint → uint256, Address, Map, etc.)
│  ├─ security-pipeline  (the 9 gates, what each catches, install hints)
│  ├─ browser-wallet     (how --browser deploy works under the hood)
│  └─ multi-chain        (supported chains + how to add new ones)
│
├─ commands/             (one MDX page per subcommand)
│  ├─ doctor
│  ├─ init
│  ├─ build
│  ├─ validate
│  ├─ verify
│  ├─ compile
│  ├─ deploy
│  ├─ secure-deploy
│  ├─ verify-source
│  ├─ audit
│  ├─ audit-pack
│  ├─ gasdiff
│  ├─ test
│  ├─ trace
│  ├─ wallet
│  └─ config
│
├─ guides/
│  ├─ verifying-on-basescan
│  ├─ writing-a-plugin
│  ├─ writing-an-invariant
│  └─ troubleshooting    (the troubleshooting section of details.md)
│
├─ reference/
│  ├─ library-api        (TypeScript exports: parseContractFiles, emitProgram, etc. — programmatic use)
│  └─ all-commands       (single-page index of every CLI subcommand, generated from cli-commands.yaml)
│
└─ docs.json             (Mintlify config — navigation, theme, metadata)
```

## Setup steps

### 1. Install + initialize Mintlify

```bash
npm install -g mintlify
mintlify init           # in the landing repo, run from a /docs subfolder
```

This scaffolds a baseline `docs.json` and a couple of starter MDX pages.

Note: Mintlify renamed `mint.json` → `docs.json` in their newer config format. Use `docs.json`.

### 2. Convert content from `docs/details.md` to MDX

`details.md` is one long file. Split it into the per-page MDX files listed in the "Proposed site structure" above. For each MDX page:

- Add frontmatter (`title`, `description`)
- Convert any GitHub-flavored Markdown that Mintlify doesn't natively support
- Replace ASCII tables with Mintlify's `<Card>` / `<Steps>` / `<AccordionGroup>` components where it improves scanability
- Use `<CodeGroup>` to show **the TypeScript source and the generated Solidity side-by-side** — this is Scriipture's signature visual; do it on every relevant page

Example MDX page (`docs/concepts/decorators.mdx`):

```mdx
---
title: "Decorators"
description: "How TypeScript decorators map to Solidity modifiers and base contracts"
---

Scriipture decorators are how you declare modifiers, visibility, and inheritance. Each decorator maps to a specific Solidity construct.

## `@onlyOwner`

<CodeGroup>
```ts MyToken.ts
import { onlyOwner } from "scriipture";

export class MyToken {
  @onlyOwner
  mint(to: Address, amount: bigint): void { /* … */ }
}
```

```solidity MyToken.sol
import "@openzeppelin/contracts/access/Ownable.sol";

contract MyToken is Ownable {
    constructor() Ownable(msg.sender) {}

    function mint(address to, uint256 amount) public onlyOwner {
        /* … */
    }
}
```
</CodeGroup>

What Scriipture does automatically: imports OZ `Ownable`, adds `is Ownable`, injects `Ownable(msg.sender)` in the constructor.

… (continue with @view, @payable, @nonReentrant, @storage, @assembly, @invariant, etc.)
```

### 3. Build `docs/docs.json`

Mintlify's nav config. Skeleton:

```json
{
  "$schema": "https://mintlify.com/docs.json",
  "theme": "mint",
  "name": "Scriipture",
  "colors": {
    "primary": "#0066FF",
    "light":   "#3385FF",
    "dark":    "#0052CC"
  },
  "favicon": "/favicon.svg",
  "navigation": {
    "tabs": [
      {
        "tab": "Documentation",
        "groups": [
          {
            "group": "Getting started",
            "pages": ["introduction", "install", "quickstart"]
          },
          {
            "group": "Concepts",
            "pages": [
              "concepts/decorators",
              "concepts/type-mapping",
              "concepts/security-pipeline",
              "concepts/browser-wallet",
              "concepts/multi-chain"
            ]
          },
          {
            "group": "Commands",
            "pages": [
              "commands/doctor",
              "commands/init",
              "commands/build",
              "commands/validate",
              "commands/verify",
              "commands/compile",
              "commands/deploy",
              "commands/secure-deploy",
              "commands/verify-source",
              "commands/audit",
              "commands/audit-pack",
              "commands/gasdiff",
              "commands/test",
              "commands/trace",
              "commands/wallet",
              "commands/config"
            ]
          },
          {
            "group": "Guides",
            "pages": [
              "guides/verifying-on-basescan",
              "guides/writing-a-plugin",
              "guides/writing-an-invariant",
              "guides/troubleshooting"
            ]
          },
          {
            "group": "Reference",
            "pages": ["reference/library-api", "reference/all-commands"]
          }
        ]
      }
    ]
  },
  "logo": {
    "light": "/logo/light.svg",
    "dark": "/logo/dark.svg"
  },
  "navbar": {
    "links": [
      { "label": "GitHub", "href": "https://github.com/Worldstreet-Web-Services/scripture" },
      { "label": "npm",    "href": "https://npmjs.com/package/scriipture" }
    ],
    "primary": {
      "type": "button",
      "label": "Get started",
      "href": "/quickstart"
    }
  },
  "footer": {
    "socials": {
      "github":  "https://github.com/Worldstreet-Web-Services/scripture"
    }
  }
}
```

> **TODO:** add `"x"` and `"website"` to `footer.socials` once Worldstreet's handles are
> confirmed. This block previously carried Zoracle's X and website URLs — they were removed
> in the handover and must not be restored.

Customize colors / logo / X handle to match the existing marketing site brand.

### 4. Theme to match the marketing brand

Mintlify's theme controls: `theme`, `colors`, `logo`, `favicon`, `fonts`. The brand colors should match the landing page. Ask the maintainer for the exact hex values; the example above (`#0066FF`) is a placeholder.

Use `<Frame>`, `<Tip>`, `<Warning>`, `<Info>`, `<Note>`, `<Card>`, `<CardGroup>`, `<Steps>`, `<AccordionGroup>` Mintlify components throughout — they look much better than plain Markdown blockquotes.

### 5. Local preview

```bash
cd docs
mintlify dev            # opens localhost:3000 with hot reload
```

Iterate. When it looks right, push.

### 6. Deploy

Two paths:

**Path A — Mintlify hosted (recommended):**
1. Sign up at https://mintlify.com
2. Install the Mintlify GitHub app on this landing page repo
3. In the Mintlify dashboard, point at the `docs/` subfolder
4. Configure custom domain (domain TBD — Worldstreet has not picked one yet)
5. Every push to `main` triggers a build; preview deployments per PR

**Path B — Self-host:**
- `mintlify build` produces a static site
- Deploy to Vercel/Netlify/Cloudflare Pages alongside the marketing site
- Configure the marketing site router to mount the docs build at `/docs/*`

Path A is the standard pattern for dev tools (Resend, Cal.com, Anthropic all use it). Path B only if you specifically need everything under one domain without subdomain DNS.

### 7. Add a docs link to the marketing nav

Once the docs are live, add a `Docs` link to the landing page navigation bar pointing to the deployed URL.

## Keeping docs in sync with Scriipture

Scriipture ships from its own repo (`Worldstreet-Web-Services/scripture`). When the maintainer adds features there, the docs in this repo need to follow. Two approaches:

**Option A — Manual sync:**
On each Scriipture release, the maintainer opens a PR here to update the relevant MDX pages. Slow but lets you tightly curate docs.

**Option B — Scripted sync:**
A small `npm run sync-docs` script fetches the latest `docs/details.md`, `openapi.yaml`, `cli-commands.yaml` from `Worldstreet-Web-Services/scripture`, diffs against the local MDX files, and surfaces what's changed. Faster, but you still need a human to review and split into MDX.

Recommend **Option B** with a CI job that runs weekly and opens a PR if upstream content has drifted.

## Content style guide

- **Audience**: TypeScript developers who have never written Solidity.
- **Tone**: direct, technical, honest. Skip marketing language inside docs — those belong on the landing page. Inside docs, lead with code and concrete examples.
- **Every page should have at least one code block** in the first 200 words.
- **Use `<CodeGroup>` for TS↔Sol comparisons** wherever the magic is in what Scriipture auto-generates.
- **Use `<Note>` for tips, `<Warning>` for footguns, `<Info>` for context.** Don't overuse — they lose force.
- **Link liberally to the Scriipture GitHub** for source-of-truth on specific functions (`https://github.com/Worldstreet-Web-Services/scripture/blob/main/src/...`).
- **Don't paste the full security-pipeline gate list on every page.** Link to `/concepts/security-pipeline` and let that be the canonical reference.

## Deliverables when you're done

- [ ] `docs/` folder in this repo with all MDX pages structured per the proposal above
- [ ] `docs/docs.json` complete with navigation, theme, and metadata
- [ ] Library API reference page covering the TypeScript exports (`parseContractFiles`, `emitProgram`, `validateProgram`, `optimizeProgram`, `compileSolidity`, plus the IR types)
- [ ] Local `mintlify dev` runs clean with no broken links / missing assets
- [ ] Theme colors + logo match the marketing brand
- [ ] Mintlify GitHub app installed + first deploy live at the chosen URL
- [ ] Docs link added to the marketing site navigation
- [ ] Optional: a `npm run sync-docs` script for upstream content drift detection

## Open questions for the maintainer

When you start work, get these answered:

1. **Which domain, and subdomain or subpath?** Worldstreet has not picked a marketing domain yet — that decision comes first, then `docs.<domain>` (Mintlify hosted) vs `<domain>/docs` (self-hosted under the marketing site).
2. **Brand colors + logo file** — need the exact hex values and SVG logo from whoever owns design.
3. **Sync cadence** — manual or scripted; weekly cron or per-release.
4. **Mintlify plan tier** — free works for most projects but custom domains and analytics often require paid; check what's needed.
5. **Versioned docs?** — if Scriipture ships breaking changes between minor versions, you might need versioned docs (`/v0.2/`, `/v0.3/`). For now, latest-only is fine.

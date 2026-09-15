import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";

interface Check {
  name: string;
  required: boolean;
  probe: () => { ok: boolean; version?: string; hint?: string };
}

const CHECKS: Check[] = [
  {
    name: "node",
    required: true,
    probe: () => probeCmd("node", "--version", "https://nodejs.org/  (or `brew install node`)"),
  },
  {
    name: "bun",
    required: false,
    probe: () => probeCmd("bun", "--version", "`curl -fsSL https://bun.sh/install | bash`  (optional, dev only)"),
  },
  {
    name: "@openzeppelin/contracts (bundled with scriipture)",
    required: true,
    probe: () => {
      const { resolveOZRoot } = require("../compiler/solc");
      const root = resolveOZRoot?.();
      if (!root) {
        return { ok: false, hint: "reinstall scriipture: `npm install scriipture`" };
      }
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
        return { ok: true, version: pkg.version };
      } catch {
        return { ok: true, version: "unknown" };
      }
    },
  },
  {
    name: "solc (native, with Z3 — runs SMTChecker in gates 3 and 8)",
    required: false,
    probe: () => probeCmd("solc", "--version", "`brew install solidity`  — without it the SMTChecker gates are recorded as skipped (the bundled solc-js cannot run Z3)"),
  },
  {
    name: "slither (Docker or native)",
    required: false,
    probe: () => {
      const { toolStatus } = require("../runtime/tool-paths");
      const s = toolStatus("slither");
      if (s.ok) return { ok: true, version: s.via };
      return { ok: false, hint: s.hint ?? "install Docker (`scriipture doctor --fix` pulls the image)" };
    },
  },
  {
    name: "mythril (Docker or native, --deep only)",
    required: false,
    probe: () => {
      const { toolStatus } = require("../runtime/tool-paths");
      const s = toolStatus("myth");
      if (s.ok) return { ok: true, version: s.via };
      return { ok: false, hint: s.hint ?? "install Docker (`scriipture doctor --fix` pulls the image)" };
    },
  },
  {
    name: "forge (Foundry, auto-fetched)",
    required: false,
    probe: () => {
      const { toolStatus } = require("../runtime/tool-paths");
      const s = toolStatus("forge");
      if (s.ok) return { ok: true, version: s.via };
      return { ok: false, hint: "auto-downloaded on first `verify`/`test`, or run `scriipture doctor --fix`" };
    },
  },
  {
    name: "anvil (local EVM, auto-fetched)",
    required: false,
    probe: () => {
      const { toolStatus } = require("../runtime/tool-paths");
      const s = toolStatus("anvil");
      if (s.ok) return { ok: true, version: s.via };
      return { ok: false, hint: "auto-downloaded with forge" };
    },
  },
];

export interface DoctorOptions {
  fix?: boolean;
}

export async function doctorCommand(opts: DoctorOptions = {}): Promise<void> {
  if (opts.fix) {
    console.log(pc.bold("scriipture doctor --fix — installing missing tools"));
    console.log("");
    const { prefetchAll } = await import("../runtime/tool-paths");
    const r = await prefetchAll();
    for (const o of r.ok) console.log(`  ${pc.green("✓")} ${o}`);
    for (const f of r.failed) console.log(`  ${pc.yellow("○")} ${f.tool}: ${pc.dim(f.error)}`);
    console.log("");
    if (r.failed.length === 0) {
      console.log(pc.green("✓ all tools ready — scriipture is self-contained"));
    } else {
      console.log(pc.yellow(`✓ ${r.ok.length} ready, ${r.failed.length} need extra setup (see hints above)`));
    }
    return;
  }

  console.log(pc.bold("scriipture doctor — environment check"));
  console.log("");
  let missingRequired = 0;
  for (const c of CHECKS) {
    const r = c.probe();
    if (r.ok) {
      console.log(`  ${pc.green("✓")} ${c.name.padEnd(40)} ${pc.dim(r.version ?? "")}`);
    } else {
      if (c.required) missingRequired++;
      const marker = c.required ? pc.red("✗") : pc.yellow("○");
      const label = c.required ? pc.red(c.name) : pc.dim(c.name);
      console.log(`  ${marker} ${label.padEnd(40)} ${pc.dim(r.hint ?? "")}`);
    }
  }
  console.log("");

  if (missingRequired > 0) {
    console.log(pc.red(`✗ ${missingRequired} required dependency missing`));
    process.exit(1);
  } else {
    const optionalMissing = CHECKS.filter((c) => !c.required && !c.probe().ok).length;
    if (optionalMissing > 0) {
      console.log(pc.yellow(`✓ all required deps present; ${optionalMissing} optional missing (see hints above)`));
    } else {
      console.log(pc.green("✓ environment is fully equipped"));
    }
  }
}

function probeCmd(cmd: string, flag: string, hint: string): { ok: boolean; version?: string; hint?: string } {
  const r = spawnSync(cmd, [flag], { encoding: "utf8" });
  if (r.status !== 0) return { ok: false, hint };
  const v = ((r.stdout || r.stderr || "").split("\n")[0] ?? "").trim();
  return { ok: true, version: v };
}

#!/usr/bin/env bun
/**
 * Generate docs/cli-commands.yaml — a machine-readable manifest of every
 * scriipture subcommand, flag, and argument.
 *
 * Uses Commander's reflection API to walk the registered command tree
 * and emit a YAML doc for downstream tooling (LSPs, codegen, etc.).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");

const probe = spawnSync("bun", ["run", "src/cli/index.ts", "--help"], {
  cwd: root,
  encoding: "utf8",
});

const helpText = probe.stdout;
const lines = helpText.split("\n");

interface CommandEntry {
  name: string;
  description: string;
  args: string[];
  options: Array<{ flag: string; description: string }>;
  examples: string[];
}

const EXAMPLES: Record<string, string[]> = {
  init: ["scriipture init my-app", "scriipture init ."],
  build: ["scriipture build contracts", "scriipture build contracts --no-optimize"],
  validate: ["scriipture validate contracts", "scriipture validate contracts --secure"],
  compile: ["scriipture compile out/sol"],
  deploy: [
    "scriipture deploy Counter -n anvil",
    "scriipture deploy MyToken -n base-sepolia -a 1000000",
    "scriipture deploy MyToken -n base --no-verify --wallet prod",
  ],
  verify: ["scriipture verify contracts", "scriipture verify contracts --skip fuzz,invariants"],
  "verify-source": ["scriipture verify-source MyToken -n base-sepolia"],
  "secure-deploy": ["scriipture secure-deploy contracts -c Counter -n base-sepolia"],
  audit: ["scriipture audit contracts"],
  "audit-pack": ["scriipture audit-pack contracts"],
  gasdiff: ["scriipture gasdiff contracts"],
  test: ["scriipture test", "scriipture test -p testFuzz"],
  trace: ["forge test 2>&1 | scriipture trace"],
  doctor: ["scriipture doctor"],
};

const commands: CommandEntry[] = [];
let inCommands = false;
for (const raw of lines) {
  if (/^Commands:/.test(raw)) { inCommands = true; continue; }
  if (inCommands) {
    const m = raw.match(/^\s{2}(\S+(?:\s+\S+)*)\s{2,}(.*)$/);
    if (m) {
      const head = m[1]!;
      const desc = m[2]!.trim();
      const [name, ...argParts] = head.split(/\s+/);
      const args = argParts.filter((a) => a.startsWith("<") || a.startsWith("["));
      commands.push({ name: name!, description: desc, args, options: [], examples: [] });
    }
  }
}

for (const cmd of commands) {
  const subHelp = spawnSync("bun", ["run", "src/cli/index.ts", cmd.name, "--help"], {
    cwd: root,
    encoding: "utf8",
  }).stdout;
  const optLines = subHelp.split("\n").filter((l) => /^\s+-/.test(l));
  for (const line of optLines) {
    const m = line.match(/^\s+(-\S(?:,\s*--[\w-]+(?:\s+<\w+(?:\.{3})?>)?)?|--[\w-]+(?:\s+<\w+(?:\.{3})?>)?)\s+(.*)$/);
    if (m) cmd.options.push({ flag: m[1]!.trim(), description: m[2]!.trim() });
  }
  cmd.examples = EXAMPLES[cmd.name] ?? [];
}

const out: string[] = [];
out.push(`# Auto-generated from commander introspection — do not edit by hand`);
out.push(`# Generated: ${new Date().toISOString()}`);
out.push(`version: 0.1.0`);
out.push(`commands:`);
for (const c of commands) {
  out.push(`  - name: ${c.name}`);
  out.push(`    description: ${yaml(c.description)}`);
  if (c.args.length > 0) {
    out.push(`    arguments:`);
    for (const a of c.args) {
      const required = a.startsWith("<");
      const name = a.replace(/[<>\[\]]/g, "");
      out.push(`      - name: ${name}`);
      out.push(`        required: ${required}`);
    }
  }
  if (c.options.length > 0) {
    out.push(`    options:`);
    for (const o of c.options) {
      out.push(`      - flag: ${yaml(o.flag)}`);
      out.push(`        description: ${yaml(o.description)}`);
    }
  }
  if (c.examples.length > 0) {
    out.push(`    examples:`);
    for (const ex of c.examples) out.push(`      - ${yaml(ex)}`);
  }
}

function yaml(s: string): string {
  if (!s) return "\"\"";
  if (/[:#&*!|>'"%@`{}\[\],]/.test(s) || /^\s|\s$/.test(s)) return JSON.stringify(s);
  return s;
}

process.stdout.write(out.join("\n") + "\n");

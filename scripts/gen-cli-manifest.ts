#!/usr/bin/env bun
/**
 * Generate docs/cli-commands.yaml — a machine-readable manifest of every
 * scriipture subcommand, flag, and argument.
 *
 * Walks the registered Commander command tree (src/cli/program.ts) and
 * emits a YAML doc for downstream tooling (LSPs, codegen, etc.).
 */
import type { Command } from "commander";
import { program } from "../src/cli/program";
import { getScriiptureVersion } from "../src/cli/version";

interface CommandEntry {
  name: string;
  description: string;
  args: Array<{ name: string; required: boolean }>;
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

/** Every command, subcommands as `config set`, read from the registered objects rather than from wrapped help text. */
const commands: CommandEntry[] = [];
const visit = (cmd: Command, prefix: string): void => {
  for (const sub of cmd.commands) {
    const name = prefix ? `${prefix} ${sub.name()}` : sub.name();
    commands.push({
      name,
      description: sub.description(),
      args: sub.registeredArguments.map((a) => ({ name: a.name(), required: a.required })),
      options: [...sub.options.map((o) => ({ flag: o.flags, description: o.description })), { flag: "-h, --help", description: "display help for command" }],
      examples: EXAMPLES[name] ?? [],
    });
    visit(sub, name);
  }
};
visit(program, "");

const out: string[] = [];
out.push(`# Auto-generated from commander introspection — do not edit by hand`);
out.push(`# Generated: ${new Date().toISOString()}`);
out.push(`version: ${getScriiptureVersion() ?? "0.0.0"}`);
out.push(`commands:`);
for (const c of commands) {
  out.push(`  - name: ${c.name}`);
  out.push(`    description: ${yaml(c.description)}`);
  if (c.args.length > 0) {
    out.push(`    arguments:`);
    for (const a of c.args) {
      out.push(`      - name: ${a.name}`);
      out.push(`        required: ${a.required}`);
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

import fs from "node:fs";
import path from "node:path";
import type { IRContract } from "../ir/types";
import { resolveContract } from "../mapper/decorators";
import type { SourceMap } from "../sourcemaps/emit";
import type { OptimizationReport } from "../optimizer/passes";
import type { Diagnostic } from "../validator/diagnostics";
import { formatDiagnostic } from "../validator/diagnostics";

export interface AuditNotesInput {
  contract: IRContract;
  tsPath: string;
  solPath: string;
  sourceMap: SourceMap;
  optimizations?: OptimizationReport;
  nativeDiagnostics: Diagnostic[];
  slitherDiagnostics: Diagnostic[];
  slitherInstalled: boolean;
}

export function renderAuditNotes(input: AuditNotesInput): string {
  const ts = fs.readFileSync(input.tsPath, "utf8");
  const sol = fs.readFileSync(input.solPath, "utf8");
  const resolution = resolveContract(input.contract);

  const sections: string[] = [];

  sections.push(`# ${input.contract.name} — Audit Notes`);
  sections.push("");
  sections.push(`- Source (TS): \`${input.tsPath}\``);
  sections.push(`- Output (Sol): \`${input.solPath}\``);
  sections.push(`- Generated: ${new Date().toISOString()}`);
  sections.push("");

  sections.push("## Auto-injected by Scriipture");
  sections.push("");
  if (resolution.inheritedContracts.length === 0 && resolution.imports.size === 0) {
    sections.push("_None — this contract uses no decorator-driven imports._");
  } else {
    if (resolution.inheritedContracts.length > 0) {
      sections.push("**Inherited base contracts** (driven by decorators or `extends`):");
      for (const b of resolution.inheritedContracts) sections.push(`- \`${b}\``);
      sections.push("");
    }
    if (resolution.imports.size > 0) {
      sections.push("**Imports**:");
      for (const i of Array.from(resolution.imports).sort()) sections.push(`- \`${i}\``);
      sections.push("");
    }
  }

  sections.push("## TypeScript source");
  sections.push("```ts");
  sections.push(...numberLines(ts));
  sections.push("```");
  sections.push("");

  sections.push("## Generated Solidity");
  sections.push("```solidity");
  sections.push(...numberLines(sol));
  sections.push("```");
  sections.push("");

  sections.push("## Line mapping (TS → Sol)");
  sections.push("");
  sections.push("| Symbol | TS line | Sol line |");
  sections.push("|---|---:|---:|");
  for (const e of input.sourceMap.entries) {
    sections.push(`| \`${e.symbol ?? ""}\` | ${e.tsLine} | ${e.solLine} |`);
  }
  sections.push("");

  if (input.optimizations) {
    sections.push("## Optimizations");
    sections.push("");
    if (input.optimizations.changes.length === 0) {
      sections.push("_None applied._");
    } else {
      sections.push("| Pass | Applied | Detail |");
      sections.push("|---|---|---|");
      for (const ch of input.optimizations.changes) {
        sections.push(`| \`${ch.pass}\` | ${ch.applied ? "✅" : "📝 hint"} | ${ch.detail} |`);
      }
    }
    sections.push("");
  }

  sections.push("## Native validator diagnostics");
  sections.push("");
  if (input.nativeDiagnostics.length === 0) {
    sections.push("_Clean — no diagnostics._");
  } else {
    for (const d of input.nativeDiagnostics) sections.push(`- ${formatDiagnostic(d)}`);
  }
  sections.push("");

  sections.push("## Slither static analysis");
  sections.push("");
  if (!input.slitherInstalled) {
    sections.push("_Slither not installed in CI for this build._");
  } else if (input.slitherDiagnostics.length === 0) {
    sections.push("_Clean — Slither found nothing above informational severity._");
  } else {
    for (const d of input.slitherDiagnostics) sections.push(`- ${formatDiagnostic(d)}`);
  }
  sections.push("");

  return sections.join("\n");
}

function numberLines(text: string): string[] {
  const lines = text.split("\n");
  const width = String(lines.length).length;
  return lines.map((line, i) => `${String(i + 1).padStart(width)} | ${line}`);
}

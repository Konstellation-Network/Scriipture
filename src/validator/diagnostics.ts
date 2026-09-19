import type { SourceLocation } from "../ir/types";

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  rule: string;
  severity: Severity;
  message: string;
  loc?: SourceLocation;
  fix?: string;
}

/**
 * A parse diagnostic is something the source said that could not be lowered at
 * all, so the emitted Solidity does not mean what the TypeScript meant. Both
 * `verify` and `audit` must report those alongside validator rules rather than
 * dropping them and letting solc complain about generated code instead.
 */
export function parseDiagnosticsAsErrors(
  parsed: Array<{ message: string; loc: { file: string; line: number; column: number } }>,
): Diagnostic[] {
  return parsed.map((d) => ({ rule: "parse", severity: "error" as const, message: d.message, loc: d.loc }));
}

export function formatDiagnostic(d: Diagnostic): string {
  const where = d.loc ? `${d.loc.file}:${d.loc.line}:${d.loc.column}` : "<unknown>";
  const fix = d.fix ? `\n    suggestion: ${d.fix}` : "";
  return `${where} [${d.severity}] ${d.rule}: ${d.message}${fix}`;
}

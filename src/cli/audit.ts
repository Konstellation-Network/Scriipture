import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { parseContractFiles } from "../parser/parse";
import { validateProgram } from "../validator/rules";
import { formatDiagnostic, parseDiagnosticsAsErrors } from "../validator/diagnostics";
import { runSlither } from "../audit/slither";
import { collectTsFiles } from "./parse";
import type { SourceMap } from "../sourcemaps/emit";

export interface AuditOptions {
  strict?: boolean;
  out?: string;
}

export async function auditCommand(input: string, opts: AuditOptions): Promise<void> {
  const files = collectTsFiles(input);
  if (files.length === 0) {
    console.error(`No .ts files found at ${input}`);
    process.exit(1);
  }

  const { program, diagnostics: parseDiagnostics } = parseContractFiles(files);
  // A construct that could not be parsed never reaches the validator, and the
  // user would otherwise only see it as a confusing solc error at compile time.
  const native = [...parseDiagnosticsAsErrors(parseDiagnostics), ...validateProgram(program)];

  const outDir = path.resolve(opts.out ?? "out/sol");
  const solFiles: string[] = [];
  const sourcemaps: SourceMap[] = [];
  for (const c of program.contracts) {
    const solPath = path.join(outDir, `${c.name}.sol`);
    if (fs.existsSync(solPath)) solFiles.push(solPath);
    const smPath = path.join(outDir, `${c.name}.sourcemap.json`);
    if (fs.existsSync(smPath)) sourcemaps.push(JSON.parse(fs.readFileSync(smPath, "utf8")));
  }

  let slitherFindings: typeof native = [];
  let slitherInstalled = false;
  if (solFiles.length > 0) {
    const r = await runSlither(solFiles, sourcemaps);
    slitherInstalled = r.installed;
    if (!r.installed) {
      console.log(pc.yellow(`⚠ slither not installed: ${r.error}`));
    } else {
      slitherFindings = r.diagnostics;
    }
  } else {
    console.log(pc.yellow("⚠ no .sol files found; run `scriipture build` first to enable slither"));
  }

  const all = [...native, ...slitherFindings];
  let errors = 0;
  for (const d of all) {
    const line = formatDiagnostic(d);
    if (d.severity === "error") {
      errors++;
      console.error(pc.red(line));
    } else if (d.severity === "warning") {
      console.warn(pc.yellow(line));
    } else {
      console.log(pc.dim(line));
    }
  }
  console.log("");
  console.log(`${native.length} native + ${slitherFindings.length} slither diagnostic(s), ${errors} error(s)${slitherInstalled ? "" : " — slither skipped"}`);
  if (opts.strict && solFiles.length > 0 && !slitherInstalled) {
    console.error(pc.red("✗ --strict: slither did not run, so this audit is incomplete"));
    process.exit(1);
  }
  if (opts.strict && all.length > 0) process.exit(1);
  if (errors > 0) process.exit(1);
}

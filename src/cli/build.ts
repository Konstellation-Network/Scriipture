import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { parseContractFiles } from "../parser/parse";
import { emitProgram } from "../emitter/emit";
import { optimizeProgram } from "../optimizer/passes";
import { buildSourceMap } from "../sourcemaps/emit";
import { validateProgram } from "../validator/rules";
import { formatDiagnostic } from "../validator/diagnostics";
import { collectTsFiles } from "./parse";

export interface BuildOptions {
  out?: string;
  noOptimize?: boolean;
  /** Apply the storage-slot reordering from `pack-slots` (changes the storage layout). */
  reorderStorage?: boolean;
  /** Emit even when the validator reports errors. The output may not say what the source said. */
  noValidate?: boolean;
}

export async function buildCommand(input: string, opts: BuildOptions): Promise<void> {
  const outDir = path.resolve(opts.out ?? "out/sol");
  const unoptDir = path.resolve("out/sol-unoptimized");
  const files = collectTsFiles(input);
  if (files.length === 0) {
    console.error(`No .ts files found at ${input}`);
    process.exit(1);
  }

  const { program, diagnostics } = parseContractFiles(files);
  for (const d of diagnostics) {
    console.error(pc.red(`${d.loc.file}:${d.loc.line}:${d.loc.column} — ${d.message}`));
  }

  // Some constructs (a `?? fallback` on an untyped value, a destructuring with
  // no known shape) can only be emitted by guessing. Guessing produces a
  // plausible-looking contract that is not the program that was written, so
  // build refuses rather than writing one.
  if (!opts.noValidate) {
    const validation = validateProgram(program);
    const errors = validation.filter((d) => d.severity === "error");
    for (const d of errors) console.error(pc.red(formatDiagnostic(d)));
    const others = validation.length - errors.length;
    if (errors.length > 0 || diagnostics.length > 0) {
      console.error("");
      console.error(pc.red(`✗ ${errors.length + diagnostics.length} error(s) — nothing was written.`));
      console.error(pc.dim("  Run `scriipture validate <input>` for the full report, or `--no-validate` to emit anyway."));
      process.exit(1);
    }
    if (others > 0) {
      console.log(pc.dim(`(${others} non-blocking diagnostic(s); run \`scriipture validate ${input}\` to see them)`));
    }
  } else if (diagnostics.length > 0) {
    console.error(pc.yellow("⚠ --no-validate: emitting despite parse errors; the output may not match the source."));
  }

  const unoptEmitted = emitProgram(program);
  fs.mkdirSync(outDir, { recursive: true });

  if (opts.noOptimize) {
    for (const c of unoptEmitted) {
      const out = path.join(outDir, `${c.name}.sol`);
      fs.writeFileSync(out, c.solidity, "utf8");
      // An interface has no function bodies, so nothing to map back to TypeScript lines.
      const contract = program.contracts.find((p) => p.name === c.name);
      if (contract) {
        const sm = buildSourceMap(contract, c.solidity);
        fs.writeFileSync(path.join(outDir, `${c.name}.sourcemap.json`), JSON.stringify(sm, null, 2));
      }
      console.log(pc.green(`wrote ${out}`) + pc.dim(" (no-optimize)"));
    }
    return;
  }

  fs.mkdirSync(unoptDir, { recursive: true });
  for (const c of unoptEmitted) {
    fs.writeFileSync(path.join(unoptDir, `${c.name}.sol`), c.solidity, "utf8");
  }

  const reports = optimizeProgram(program, { reorderStorage: opts.reorderStorage });
  const optEmitted = emitProgram(program);

  for (const c of optEmitted) {
    const out = path.join(outDir, `${c.name}.sol`);
    fs.writeFileSync(out, c.solidity, "utf8");
    if (c.kind === "interface") {
      console.log(pc.green(`wrote ${out}`) + pc.dim(" (interface)"));
      continue;
    }

    const sm = buildSourceMap(program.contracts.find((p) => p.name === c.name)!, c.solidity);
    fs.writeFileSync(path.join(outDir, `${c.name}.sourcemap.json`), JSON.stringify(sm, null, 2));

    const report = reports.find((r) => r.contract === c.name);
    if (report) {
      fs.writeFileSync(
        path.join(outDir, `${c.name}.optimizations.json`),
        JSON.stringify(report, null, 2),
      );
      const applied = report.changes.filter((ch) => ch.applied).length;
      const advisory = report.changes.length - applied;
      console.log(
        pc.green(`wrote ${out}`) +
          pc.dim(`  (${applied} optimization${applied === 1 ? "" : "s"} applied, ${advisory} hint${advisory === 1 ? "" : "s"})`),
      );
    } else {
      console.log(pc.green(`wrote ${out}`));
    }
  }
}

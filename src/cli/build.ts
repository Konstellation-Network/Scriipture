import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { parseContractFiles } from "../parser/parse";
import { emitProgram } from "../emitter/emit";
import { optimizeProgram } from "../optimizer/passes";
import { buildSourceMap } from "../sourcemaps/emit";
import { collectTsFiles } from "./parse";

export interface BuildOptions {
  out?: string;
  noOptimize?: boolean;
  /** Apply the storage-slot reordering from `pack-slots` (changes the storage layout). */
  reorderStorage?: boolean;
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
    console.error(`${d.loc.file}:${d.loc.line}:${d.loc.column} — ${d.message}`);
  }

  const unoptEmitted = emitProgram(program);
  fs.mkdirSync(outDir, { recursive: true });

  if (opts.noOptimize) {
    for (const c of unoptEmitted) {
      const out = path.join(outDir, `${c.name}.sol`);
      fs.writeFileSync(out, c.solidity, "utf8");
      const sm = buildSourceMap(program.contracts.find((p) => p.name === c.name)!, c.solidity);
      fs.writeFileSync(path.join(outDir, `${c.name}.sourcemap.json`), JSON.stringify(sm, null, 2));
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

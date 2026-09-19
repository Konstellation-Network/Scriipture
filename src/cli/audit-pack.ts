import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pc from "picocolors";
import { parseContractFiles } from "../parser/parse";
import { validateProgram } from "../validator/rules";
import { optimizeProgram } from "../optimizer/passes";
import { emitProgram } from "../emitter/emit";
import { buildSourceMap } from "../sourcemaps/emit";
import { renderAuditNotes } from "../audit/notes";
import { runSlither } from "../audit/slither";
import { collectTsFiles } from "./parse";

export interface AuditPackOptions {
  out?: string;
  noZip?: boolean;
}

export async function auditPackCommand(input: string, opts: AuditPackOptions): Promise<void> {
  const files = collectTsFiles(input);
  if (files.length === 0) {
    console.error(`No .ts files found at ${input}`);
    process.exit(1);
  }

  const { program } = parseContractFiles(files);
  const native = validateProgram(program);
  const reports = optimizeProgram(program);
  const emitted = emitProgram(program);

  const auditRoot = path.resolve(opts.out ?? "out/audit");
  fs.mkdirSync(auditRoot, { recursive: true });

  for (let i = 0; i < emitted.length; i++) {
    const e = emitted[i]!;
    const contract = program.contracts[i]!;
    const dir = path.join(auditRoot, contract.name);
    fs.mkdirSync(dir, { recursive: true });

    const tsTarget = path.join(dir, path.basename(contract.sourceFile));
    fs.copyFileSync(contract.sourceFile, tsTarget);

    const solTarget = path.join(dir, `${contract.name}.sol`);
    fs.writeFileSync(solTarget, e.solidity, "utf8");

    const sm = buildSourceMap(contract, e.solidity);
    fs.writeFileSync(path.join(dir, `${contract.name}.sourcemap.json`), JSON.stringify(sm, null, 2));

    const slither = await runSlither([solTarget], [sm]);
    if (slither.installed && slither.raw) {
      fs.writeFileSync(path.join(dir, `${contract.name}.slither.json`), JSON.stringify(slither.raw, null, 2));
    }

    const notes = renderAuditNotes({
      contract,
      tsPath: tsTarget,
      solPath: solTarget,
      sourceMap: sm,
      optimizations: reports.find((r) => r.contract === contract.name),
      nativeDiagnostics: native.filter((d) => d.loc?.file === contract.sourceFile),
      slitherDiagnostics: slither.diagnostics,
      slitherInstalled: slither.installed,
    });
    fs.writeFileSync(path.join(dir, `${contract.name}.audit.md`), notes);

    if (!opts.noZip) {
      const zipPath = path.join(auditRoot, `${contract.name}.zip`);
      const r = spawnSync("zip", ["-r", "-q", zipPath, contract.name], { cwd: auditRoot, env: process.env });
      if (r.status === 0) {
        console.log(pc.green(`packed ${zipPath}`));
      } else {
        console.log(pc.yellow(`pack dir written: ${dir} (zip cmd not available)`));
      }
    } else {
      console.log(pc.green(`wrote ${dir}`));
    }
  }
}

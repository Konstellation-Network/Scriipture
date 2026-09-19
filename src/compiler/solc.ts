import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import solc from "solc";
import type { Config } from "../config/schema";

export interface CompiledArtifact {
  contractName: string;
  abi: unknown[];
  bytecode: string;
  deployedBytecode: string;
}

export interface SMTCheckerFinding {
  severity: "warning" | "error";
  message: string;
  file?: string;
  line?: number;
}

/**
 * Whether the SMTChecker actually executed. The solc-js (Emscripten) build
 * cannot start the Z3 solver thread, so model checking needs a native `solc`
 * on the PATH; when neither works the gate must be recorded as skipped, not
 * as "0 findings".
 */
export interface ModelCheckerStatus {
  ran: boolean;
  engine?: "native-solc" | "solc-js";
  version?: string;
  reason?: string;
}

export interface CompileResult {
  artifacts: CompiledArtifact[];
  errors: string[];
  warnings: string[];
  smtFindings: SMTCheckerFinding[];
  standardJsonInput: string;
  modelChecker?: ModelCheckerStatus;
}

export interface CompileInput {
  solFiles: string[];
  config: Config;
  modelCheck?: boolean;
}

const SMT_UNAVAILABLE_HINT = "install a native solc (`brew install solidity`, or a static build from github.com/ethereum/solidity/releases)";

export function compileSolidity({ solFiles, config, modelCheck = false }: CompileInput): CompileResult {
  const sources: Record<string, { content: string }> = {};
  for (const f of solFiles) {
    sources[path.basename(f)] = { content: fs.readFileSync(f, "utf8") };
  }

  const settings: any = {
    optimizer: {
      enabled: config.compiler.optimizer.enabled,
      runs: config.compiler.optimizer.runs,
    },
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"],
      },
    },
  };

  if (modelCheck) {
    settings.modelChecker = {
      engine: "chc",
      targets: ["assert", "underflow", "overflow", "divByZero", "balance", "popEmptyArray"],
      timeout: 15000,
      invariants: ["contract"],
      showUnproved: true,
    };
  }

  let output: any;
  let modelChecker: ModelCheckerStatus | undefined;
  let inputJson: string;

  const native = modelCheck ? nativeSolc() : null;
  if (modelCheck && native) {
    // Native solc gets every import inlined so it needs no filesystem access.
    inlineImports(sources);
    inputJson = JSON.stringify({ language: "Solidity", sources, settings });
    const r = spawnSync(native.path, ["--standard-json"], { input: inputJson, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    try {
      output = JSON.parse(r.stdout || "{}");
      modelChecker = { ran: true, engine: "native-solc", version: native.version };
    } catch {
      output = { errors: [{ severity: "error", message: `native solc produced no JSON: ${(r.stderr || "").split("\n")[0]}` }] };
      modelChecker = { ran: false, reason: `native solc at ${native.path} failed: ${(r.stderr || "").split("\n")[0]}` };
    }
  } else {
    inputJson = JSON.stringify({ language: "Solidity", sources, settings });
    output = JSON.parse(solc.compile(inputJson, { import: importResolver }));
    if (modelCheck) modelChecker = { ran: true, engine: "solc-js", version: solc.version() };
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const smtFindings: SMTCheckerFinding[] = [];
  if (output.errors) {
    for (const e of output.errors) {
      const msg: string = e.formattedMessage ?? e.message ?? String(e);
      if (modelCheck && isSolverFailure(e)) {
        // solc-js: "thread constructor failed" from Z3; the compile itself is fine, the checker never ran.
        modelChecker = { ran: false, engine: modelChecker?.engine, reason: `the ${modelChecker?.engine ?? "solc"} build could not start the Z3 solver — ${SMT_UNAVAILABLE_HINT}` };
        continue;
      }
      if (e.errorCode && String(e.errorCode).startsWith("64")) {
        const loc = e.sourceLocation ?? {};
        smtFindings.push({
          severity: e.severity === "error" ? "error" : "warning",
          message: msg,
          file: loc.file,
          line: lineFromOffset(sources[loc.file]?.content, loc.start),
        });
      } else if (e.severity === "error") {
        errors.push(msg);
      } else {
        warnings.push(msg);
      }
    }
  }

  const artifacts: CompiledArtifact[] = [];
  if (output.contracts) {
    for (const file of Object.keys(output.contracts)) {
      for (const contractName of Object.keys(output.contracts[file])) {
        const c = output.contracts[file][contractName];
        if (!c.abi || !c.evm) continue;
        artifacts.push({
          contractName,
          abi: c.abi,
          bytecode: "0x" + c.evm.bytecode.object,
          deployedBytecode: "0x" + c.evm.deployedBytecode.object,
        });
      }
    }
  }

  // Model checking with no solver never produces findings; say so rather than reporting a clean run.
  if (modelCheck && modelChecker?.ran && errors.length > 0) {
    modelChecker = { ...modelChecker, ran: false, reason: `compile failed during model checking: ${firstLine(errors[0]!)}` };
  }

  return { artifacts, errors, warnings, smtFindings, standardJsonInput: inputJson, modelChecker };
}

function firstLine(s: string): string {
  return s.split("\n")[0]?.trim() ?? s;
}

function isSolverFailure(e: any): boolean {
  const msg = String(e.formattedMessage ?? e.message ?? "");
  if (e.type === "Exception" && /thread|solver|z3|smt/i.test(msg)) return true;
  return /thread constructor failed|no SMT solver|SMT solver .* not available/i.test(msg);
}

/** A native `solc` binary on the PATH, if any. */
export function nativeSolc(): { path: string; version: string } | null {
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["solc"], { encoding: "utf8" });
  const p = (which.stdout || "").split("\n")[0]?.trim();
  if (which.status !== 0 || !p) return null;
  const v = spawnSync(p, ["--version"], { encoding: "utf8" });
  if (v.status !== 0) return null;
  const version = (v.stdout || "").split("\n").find((l) => /^Version:/.test(l))?.replace(/^Version:\s*/, "") ?? "unknown";
  return { path: p, version };
}

/**
 * Pull every transitively imported file into the sources map, keyed by the
 * source unit name solc will look for, so a native solc can compile with
 * `--standard-json` and no `--allow-paths`.
 */
function inlineImports(sources: Record<string, { content: string }>): void {
  const queue = Object.keys(sources);
  while (queue.length > 0) {
    const unit = queue.shift()!;
    const content = sources[unit]!.content;
    for (const m of content.matchAll(/^\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']\s*;/gm)) {
      const spec = m[1]!;
      const resolved = spec.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(unit), spec)) : spec;
      if (sources[resolved]) continue;
      const found = importResolver(resolved);
      if ("contents" in found) {
        sources[resolved] = { content: found.contents };
        queue.push(resolved);
      }
    }
  }
}

function lineFromOffset(content: string | undefined, offset: number | undefined): number | undefined {
  if (!content || typeof offset !== "number") return undefined;
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

function importResolver(importPath: string): { contents: string } | { error: string } {
  for (const c of resolveImportCandidates(importPath)) {
    if (fs.existsSync(c)) return { contents: fs.readFileSync(c, "utf8") };
  }
  return { error: `File not found: ${importPath}` };
}

export function resolveImportCandidates(importPath: string): string[] {
  const out = new Set<string>();
  out.add(path.join("node_modules", importPath));
  out.add(path.join(process.cwd(), "node_modules", importPath));
  try {
    const selfDir = path.dirname(new URL(import.meta.url).pathname);
    const upTwo = path.resolve(selfDir, "..", "..");
    const upThree = path.resolve(selfDir, "..", "..", "..");
    out.add(path.join(upTwo, "node_modules", importPath));
    out.add(path.join(upThree, "node_modules", importPath));
    out.add(path.join(upTwo, importPath));
    out.add(path.join(upThree, importPath));
  } catch { /* ignore */ }
  return Array.from(out);
}

export function resolveOZRoot(): string | null {
  for (const c of resolveImportCandidates("@openzeppelin/contracts/package.json")) {
    if (fs.existsSync(c)) return path.dirname(c);
  }
  return null;
}

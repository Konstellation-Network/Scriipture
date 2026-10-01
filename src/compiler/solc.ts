import fs from "node:fs";
import os from "node:os";
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
  /**
   * What the solver concluded, which is NOT solc's severity: the SMTChecker
   * reports every finding through `warning()` or `info()` and never `error()`,
   * so reading solc's severity classifies a real counterexample as a warning
   * and lets the gate pass.
   *
   * - `error`: the solver found a counterexample ("… happens here").
   * - `warning`: the solver could not settle the property ("… might happen here").
   * - `info`: commentary, e.g. "N verification condition(s) proved safe!".
   */
  severity: "info" | "warning" | "error";
  /**
   * Which target the finding belongs to.
   *
   * - `assertion`: an `assert` that can fail — always a bug, and what the
   *   generated `@invariant` harness asserts, so these block the gate.
   * - `arithmetic`: overflow, underflow, division by zero, popping an empty
   *   array. Under Solidity 0.8 these revert rather than corrupt state, so
   *   they are reported but do not block; `showUnproved` makes them common.
   * - `other`: everything else, including the "proved safe" notes.
   */
  kind: "assertion" | "arithmetic" | "other";
  message: string;
  /** solc's own error code, e.g. 6328 for an assertion violation. */
  errorCode?: string;
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

const SMT_UNAVAILABLE_HINT = "put a native solc built with a Horn solver on PATH — the bundled solc-js cannot start one, and the official release binaries are built without Z3. `scriipture doctor` tests a candidate build directly, since the version number does not say.";

/**
 * Every SMTChecker message is prefixed with the engine that produced it.
 * Matching on that is stable; matching on the error code is not, because CHC
 * and BMC emit ~50 distinct codes (6328 assertion violation, 4984 overflow,
 * 3944 underflow, 4281 division by zero, 2529 empty pop, 6368 out of bounds,
 * 5840 unproved, …) with no shared prefix.
 */
const SMT_MESSAGE = /^(CHC|BMC):/;

/** solc codes for "the model checker could not run at all", as opposed to a finding. */
const SOLVER_UNAVAILABLE_CODES = new Set(["7649", "7710", "8158", "4591", "1180"]);

export function isSmtDiagnostic(e: { message?: string }): boolean {
  return SMT_MESSAGE.test(String(e.message ?? "").trim());
}

/**
 * Classify an SMTChecker message by what the solver concluded. solc says
 * "happens here" when it has a counterexample and "might happen here" when it
 * could not decide, and that distinction is the whole value of the gate.
 */
export function smtSeverity(message: string): "info" | "warning" | "error" {
  if (/\bhappens here\b/i.test(message)) return "error";
  if (/might happen here|might be|unproved|could not prove|cannot be proved/i.test(message)) return "warning";
  return "info";
}

/** Which class of property a finding is about; see `SMTCheckerFinding.kind`. */
export function smtKind(message: string): "assertion" | "arithmetic" | "other" {
  if (/assertion violation/i.test(message)) return "assertion";
  if (/overflow|underflow|division by zero|empty array|out of bounds/i.test(message)) return "arithmetic";
  return "other";
}

/**
 * True when solc is telling us the model checker did not run: no Horn solver
 * compiled in (the official release binaries are built without Z3), the
 * requested solver missing, or the solc-js build failing to start its thread.
 */
export function isSolverUnavailable(e: { errorCode?: string | number; type?: string; message?: string; formattedMessage?: string }): boolean {
  if (e.errorCode !== undefined && SOLVER_UNAVAILABLE_CODES.has(String(e.errorCode))) return true;
  const msg = String(e.formattedMessage ?? e.message ?? "");
  if (e.type === "Exception" && /thread|solver|z3|smt/i.test(msg)) return true;
  return /thread constructor failed|no Horn solver|analysis was not possible|but it is not available|SMT solver .* not available|no SMT solver/i.test(msg);
}

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
    const r = spawnSync(native.path, ["--standard-json"], { input: inputJson, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: process.env });
    // A crash, an OOM kill, a maxBuffer overflow or a failed spawn all leave
    // stdout empty, and "" || "{}" parses as "no errors" -- a clean run.
    const died = r.error
      ? `could not run (${r.error.message})`
      : r.signal
        ? `was killed by signal ${r.signal}`
        : r.status !== 0
          ? `exited ${r.status}${(r.stderr || "").trim() ? `: ${firstLine(r.stderr)}` : ""}`
          : null;
    if (died) {
      output = {};
      modelChecker = { ran: false, engine: "native-solc", version: native.version, reason: `native solc at ${native.path} ${died}` };
    } else {
      try {
        output = JSON.parse(r.stdout || "");
        modelChecker = { ran: true, engine: "native-solc", version: native.version };
      } catch {
        output = {};
        modelChecker = { ran: false, engine: "native-solc", version: native.version, reason: `native solc at ${native.path} produced no JSON output` };
      }
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
      if (modelCheck && isSolverUnavailable(e)) {
        // The compile itself is fine; the checker never ran. Reporting "0 findings"
        // here is exactly the "clean vs never ran" ambiguity an attestation must not have.
        modelChecker = {
          ran: false,
          engine: modelChecker?.engine,
          version: modelChecker?.version,
          reason: `${firstLine(String(e.message ?? msg))} — ${SMT_UNAVAILABLE_HINT}`,
        };
        continue;
      }
      if (modelCheck && isSmtDiagnostic(e)) {
        const loc = e.sourceLocation ?? {};
        smtFindings.push({
          severity: smtSeverity(String(e.message ?? msg)),
          kind: smtKind(String(e.message ?? msg)),
          message: msg,
          errorCode: e.errorCode !== undefined ? String(e.errorCode) : undefined,
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

/**
 * Ask the resolved solc whether it can actually run the model checker, by
 * compiling a two-line contract whose assertion is trivially provable. Two
 * builds reporting the same version differ in whether a Horn solver is
 * compiled in, so this is the only reliable answer.
 */
export function probeModelChecker(config: Config): ModelCheckerStatus {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-smtprobe-"));
  const file = path.join(dir, "SmtProbe.sol");
  fs.writeFileSync(
    file,
    "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract SmtProbe { function f(uint256 x) public pure { assert(x == x); } }\n",
    "utf8",
  );
  try {
    return compileSolidity({ solFiles: [file], config, modelCheck: true }).modelChecker
      ?? { ran: false, reason: "model checker produced no status" };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A native `solc` binary on the PATH, if any. */
export function nativeSolc(): { path: string; version: string } | null {
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["solc"], { encoding: "utf8", env: process.env });
  const p = (which.stdout || "").split("\n")[0]?.trim();
  if (which.status !== 0 || !p) return null;
  const v = spawnSync(p, ["--version"], { encoding: "utf8", env: process.env });
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

/**
 * The solc version forge and Mythril should run: the configured one, raised
 * to the lowest release every emitted `pragma solidity ^0.8.N` admits.
 * Pinning the configured version alone fails outright once a file needs a
 * newer compiler -- transient storage needs 0.8.28.
 */
export function toolSolcVersion(solidity: string[], configured = "0.8.20"): string {
  const parse = (v: string) => v.split(".").map(Number) as [number, number, number];
  const newer = (a: string, b: string) => {
    const [x, y] = [parse(a), parse(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
    return false;
  };
  let out = configured;
  for (const src of solidity) {
    for (const m of src.matchAll(/pragma solidity \^(\d+\.\d+\.\d+)\s*;/g)) if (newer(m[1]!, out)) out = m[1]!;
  }
  return out;
}

/**
 * The `solc = "…"` line of a generated foundry.toml: the configured version
 * when every source accepts it, otherwise none, so forge picks an installed
 * compiler that satisfies the pragmas instead of downloading one exact build.
 */
export function foundrySolcLine(solidity: string[], configured = "0.8.20"): string {
  return toolSolcVersion(solidity, configured) === configured ? `solc = "${configured}"\n` : "";
}

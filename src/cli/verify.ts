import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pc from "picocolors";
import { parseContractFiles } from "../parser/parse";
import { emitProgram } from "../emitter/emit";
import { optimizeProgram } from "../optimizer/passes";
import { buildSourceMap } from "../sourcemaps/emit";
import { validateProgram } from "../validator/rules";
import { loadConfig } from "../config/load";
import { compileSolidity } from "../compiler/solc";
import { runSlither, slitherInstalled } from "../audit/slither";
import { runMythril, mythrilInstalled } from "../audit/mythril";
import { resolveTool } from "../runtime/tool-paths";
import { generateFuzzHarness } from "../security/fuzz-gen";
import { collectInvariants, renderInvariantTest } from "../security/invariants";
import { checkPatterns } from "../security/pattern-library";
import {
  collectToolVersions,
  sha256,
  writeAttestation,
  gatePassed,
  gateFailed,
  gateSkipped,
  gateNotApplicable,
  type AttestationBundle,
  type GateResult,
} from "../security/attestation";
import { collectTsFiles } from "./parse";

export interface VerifyOptions {
  out?: string;
  noFuzz?: boolean;
  noSmt?: boolean;
  noSlither?: boolean;
  noMythril?: boolean;
  noInvariants?: boolean;
  noPatterns?: boolean;
  noFuzzRun?: boolean;
  fuzzRuns?: number;
  skip?: string[];
  deep?: boolean;
  mythrilTimeout?: number;
  /** Apply the storage-slot reordering from `pack-slots` (changes the storage layout). */
  reorderStorage?: boolean;
  /** Recorded on every skipped gate so the attestation says why it did not run. */
  skipJustification?: string;
}

export function applySkipList(opts: VerifyOptions): VerifyOptions {
  if (!opts.skip || opts.skip.length === 0) return opts;
  const set = new Set(opts.skip.flatMap((s) => s.split(",")).map((s) => s.trim().toLowerCase()));
  return {
    ...opts,
    noFuzz: opts.noFuzz || set.has("fuzz"),
    noSmt: opts.noSmt || set.has("smt") || set.has("smt-checker"),
    noSlither: opts.noSlither || set.has("slither"),
    noMythril: opts.noMythril || set.has("mythril"),
    noInvariants: opts.noInvariants || set.has("invariants") || set.has("invariant"),
    noPatterns: opts.noPatterns || set.has("patterns") || set.has("pattern"),
    noFuzzRun: opts.noFuzzRun || set.has("fuzz-run") || set.has("forge"),
  };
}

export interface ContractGateResult extends GateResult {
  contract: string;
}

export interface VerifyResult {
  ok: boolean;
  /** Every per-contract gate result, exactly as written to the attestation bundles. */
  gates: ContractGateResult[];
  attestations: Array<{ contract: string; path: string; fingerprint: string }>;
}

export async function verifyCommand(input: string, opts: VerifyOptions): Promise<VerifyResult> {
  opts = applySkipList(opts);
  const config = await loadConfig();
  const files = collectTsFiles(input);
  if (files.length === 0) {
    console.error(pc.red(`No .ts files found at ${input}`));
    process.exit(1);
  }

  const outDir = path.resolve(opts.out ?? "out");
  const solDir = path.join(outDir, "sol");
  const auditDir = path.join(outDir, "audit");
  const forgeRoot = path.join(outDir, "forge");
  fs.mkdirSync(solDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });

  const { program } = parseContractFiles(files);
  const optimizations = optimizeProgram(program, { reorderStorage: opts.reorderStorage });
  const emitted = emitProgram(program);

  for (const e of emitted) fs.writeFileSync(path.join(solDir, `${e.name}.sol`), e.solidity, "utf8");

  const allResults: VerifyResult = { ok: true, gates: [], attestations: [] };
  const contractGates = new Map<string, GateResult[]>();
  for (const c of program.contracts) contractGates.set(c.name, []);
  const record = (contractName: string, result: GateResult): void => {
    contractGates.get(contractName)!.push(result);
  };
  const recordAll = (result: GateResult): void => {
    for (const c of program.contracts) record(c.name, { ...result });
  };
  const skipped = (name: string, reason: string, optIn = false): GateResult =>
    gateSkipped(name, reason, { justification: opts.skipJustification, optIn });

  // Gate 1 — native validator (secure mode)
  banner("Gate 1/9 — native validator (secure mode)");
  const native = validateProgram(program, { secure: true });
  const nativeErrors = native.filter((d) => d.severity === "error");
  const gate1Ok = nativeErrors.length === 0;
  for (const c of program.contracts) {
    const mine = nativeErrors.filter((d) => d.loc?.file === c.sourceFile).length;
    const detail = `${native.length} diagnostic(s), ${nativeErrors.length} error(s)`;
    record(c.name, mine === 0 ? gatePassed("native-validator", detail, native.length) : gateFailed("native-validator", detail, native.length));
  }
  if (!gate1Ok) allResults.ok = false;
  reportGate(gate1Ok, `${nativeErrors.length} error(s), ${native.length} total diagnostic(s)`);
  for (const d of nativeErrors) console.error(pc.red(`  ${d.loc?.file}:${d.loc?.line}: [${d.rule}] ${d.message}`));

  // Gate 2 — solc compile
  banner("Gate 2/9 — solc compile");
  const solFiles = emitted.map((e) => path.join(solDir, `${e.name}.sol`));
  const compileResult = compileSolidity({ solFiles, config });
  const gate2Ok = compileResult.errors.length === 0;
  recordAll(gate2Ok ? gatePassed("solc-compile", "clean") : gateFailed("solc-compile", `${compileResult.errors.length} compile error(s)`));
  if (!gate2Ok) allResults.ok = false;
  reportGate(gate2Ok, gate2Ok ? "clean" : `${compileResult.errors.length} error(s)`);
  for (const e of compileResult.errors.slice(0, 3)) console.error(pc.red(`  ${e.split("\n")[0]}`));

  // Gate 3 — SMTChecker
  banner("Gate 3/9 — SMTChecker");
  if (opts.noSmt) {
    reportGate(true, "skipped (--no-smt)");
    recordAll(skipped("smt-checker", "skipped (--no-smt)"));
  } else {
    const smtResult = compileSolidity({ solFiles, config, modelCheck: true });
    const smtErrors = smtResult.smtFindings.filter((f) => f.severity === "error");
    const gate3Ok = smtErrors.length === 0;
    for (const c of program.contracts) {
      const mine = smtResult.smtFindings.filter((f) => path.basename(f.file ?? "") === `${c.name}.sol`);
      const errors = mine.filter((f) => f.severity === "error").length;
      const detail = `${mine.length} finding(s)`;
      record(c.name, errors === 0 ? gatePassed("smt-checker", detail, mine.length) : gateFailed("smt-checker", detail, mine.length));
    }
    if (!gate3Ok) allResults.ok = false;
    reportGate(gate3Ok, `${smtResult.smtFindings.length} finding(s), ${smtErrors.length} error(s)`);
    for (const f of smtResult.smtFindings.slice(0, 3)) {
      const tag = f.severity === "error" ? pc.red : pc.yellow;
      console.log(`  ${tag(`[${f.severity}]`)} ${f.message.split("\n")[0]}`);
    }
  }

  // Gate 4 — Mythril (symbolic execution, opt-in via --deep)
  banner("Gate 4/9 — Mythril (symbolic execution)");
  if (!opts.deep) {
    reportGate(true, "skipped (run `scriipture verify --deep` to enable; mythril is slow, ~90s/contract)");
    recordAll(skipped("mythril", "skipped (opt-in gate; --deep not set)", true));
  } else if (opts.noMythril) {
    reportGate(true, "skipped (--skip mythril)");
    recordAll(skipped("mythril", "skipped (--skip mythril)"));
  } else if (!mythrilInstalled()) {
    reportGate(false, "mythril not installed — `pipx install mythril` or `docker pull mythril/myth`");
    allResults.ok = false;
    recordAll(gateFailed("mythril", "not installed"));
  } else {
    const sourcemapsM = program.contracts.map((c) => {
      const sol = fs.readFileSync(path.join(solDir, `${c.name}.sol`), "utf8");
      return buildSourceMap(c, sol);
    });
    const r = await runMythril(solFiles, sourcemapsM, { timeout: opts.mythrilTimeout });
    const errors = r.diagnostics.filter((d) => d.severity === "error");
    const gateMOk = errors.length === 0;
    for (const c of program.contracts) {
      const mine = r.findings.filter((f) => f.solFile === `${c.name}.sol`);
      const high = mine.filter((f) => f.severity === "error").length;
      const detail = `${mine.length} finding(s)`;
      record(c.name, high === 0 ? gatePassed("mythril", detail, mine.length) : gateFailed("mythril", detail, mine.length));
    }
    if (!gateMOk) allResults.ok = false;
    reportGate(gateMOk, `${r.findings.length} issue(s), ${errors.length} high-severity`);
    for (const d of r.diagnostics.slice(0, 3)) {
      const tag = d.severity === "error" ? pc.red : pc.yellow;
      console.log(`  ${tag(`[${d.severity}]`)} ${d.rule}: ${d.message.split("\n")[0]}`);
    }
  }

  // Gate 5 — Slither
  banner("Gate 5/9 — Slither");
  if (opts.noSlither) {
    reportGate(true, "skipped (--no-slither)");
    recordAll(skipped("slither", "skipped (--no-slither)"));
  } else if (!slitherInstalled()) {
    reportGate(false, "slither not installed — brew install slither-analyzer");
    allResults.ok = false;
    recordAll(gateFailed("slither", "not installed"));
  } else {
    const sourcemaps = program.contracts.map((c) => {
      const sol = fs.readFileSync(path.join(solDir, `${c.name}.sol`), "utf8");
      return buildSourceMap(c, sol);
    });
    const r = await runSlither(solFiles, sourcemaps);
    const errors = r.diagnostics.filter((d) => d.severity === "error");
    const gate4Ok = errors.length === 0;
    for (const c of program.contracts) {
      const mine = r.findings.filter((f) => f.solFile === `${c.name}.sol`);
      const high = mine.filter((f) => f.severity === "error").length;
      const detail = `${mine.length} finding(s)`;
      record(c.name, high === 0 ? gatePassed("slither", detail, mine.length) : gateFailed("slither", detail, mine.length));
    }
    if (!gate4Ok) allResults.ok = false;
    reportGate(gate4Ok, `${r.findings.length} finding(s), ${errors.length} high-severity`);
    for (const d of r.diagnostics.slice(0, 3)) {
      const tag = d.severity === "error" ? pc.red : pc.yellow;
      console.log(`  ${tag(`[${d.severity}]`)} ${d.rule}: ${d.message.split("\n")[0]}`);
    }
  }

  // Gate 6 — pattern library
  banner("Gate 6/9 — pattern library");
  if (opts.noPatterns) {
    reportGate(true, "skipped (--no-patterns)");
    recordAll(skipped("pattern-library", "skipped (--no-patterns)"));
  } else {
    let gate5Ok = true;
    for (const c of program.contracts) {
      const r = checkPatterns(c);
      record(c.name, r.ok ? gatePassed("pattern-library", "all bases/imports recognized") : gateFailed("pattern-library", r.findings.join("; ")));
      if (!r.ok) {
        gate5Ok = false;
        for (const f of r.findings) console.log(`  ${pc.yellow("[warn]")} ${c.name}: ${f}`);
      }
    }
    if (!gate5Ok) allResults.ok = false;
    reportGate(gate5Ok, gate5Ok ? "all contracts use known-safe bases/imports" : "drift detected");
  }

  // Gate 7 — fuzz harnesses (generation + run)
  banner("Gate 7/9 — auto-generated fuzz harnesses");
  if (opts.noFuzz) {
    reportGate(true, "skipped (--no-fuzz)");
    recordAll(skipped("fuzz-harness-generated", "skipped (--no-fuzz)"));
    recordAll(skipped("fuzz-run", "skipped (--no-fuzz)"));
  } else {
    fs.mkdirSync(path.join(forgeRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(forgeRoot, "test"), { recursive: true });
    for (const e of emitted) fs.writeFileSync(path.join(forgeRoot, "src", `${e.name}.sol`), e.solidity, "utf8");

    const harnessed = new Set<string>();
    for (const c of program.contracts) {
      const h = generateFuzzHarness(c);
      if (h) {
        fs.writeFileSync(path.join(forgeRoot, "test", h.filename), h.solidity, "utf8");
        harnessed.add(c.name);
        record(c.name, gatePassed("fuzz-harness-generated", h.filename));
      } else {
        record(c.name, gateNotApplicable("fuzz-harness-generated", "ctor needs args or no public methods"));
      }
    }

    if (harnessed.size === 0) {
      reportGate(true, "no harnesses to run");
      recordAll(gateNotApplicable("fuzz-run", "no harness generated"));
    } else if (opts.noFuzzRun) {
      reportGate(true, "generation only (--no-fuzz-run)");
      for (const c of program.contracts) {
        record(c.name, harnessed.has(c.name)
          ? skipped("fuzz-run", "skipped (--skip fuzz-run)")
          : gateNotApplicable("fuzz-run", "no harness generated"));
      }
    } else {
      ensureForgeProject(forgeRoot);
      const runs = opts.fuzzRuns ?? 1000;
      const forge = await resolveTool("forge");
      const r = spawnSync(forge.cmd, [...forge.argPrefix, "test", "--root", forgeRoot, "--fuzz-runs", String(runs), "--match-contract", "FuzzAuto"], { stdio: "inherit" });
      const gate6Ok = r.status === 0;
      for (const c of program.contracts) {
        if (!harnessed.has(c.name)) {
          record(c.name, gateNotApplicable("fuzz-run", "no harness generated"));
        } else {
          record(c.name, gate6Ok ? gatePassed("fuzz-run", `${runs} runs/method clean`) : gateFailed("fuzz-run", "forge test failed"));
        }
      }
      if (!gate6Ok) allResults.ok = false;
      reportGate(gate6Ok, `${harnessed.size} harness(es), ${runs} runs each`);
    }
  }

  // Gate 8 — invariant tests
  banner("Gate 8/9 — invariant tests");
  if (opts.noInvariants) {
    reportGate(true, "skipped (--no-invariants)");
    recordAll(skipped("invariant-tests", "skipped (--no-invariants)"));
  } else {
    const emittedInvariants = new Map<string, number>();
    for (const c of program.contracts) {
      const invs = collectInvariants(c);
      if (invs.length === 0) {
        record(c.name, gateNotApplicable("invariant-tests", "no invariants declared"));
        continue;
      }
      const sol = renderInvariantTest(c, invs);
      if (!sol) {
        record(c.name, gateNotApplicable("invariant-tests", "constructor needs args; manual harness required"));
        continue;
      }
      fs.mkdirSync(path.join(forgeRoot, "src"), { recursive: true });
      fs.mkdirSync(path.join(forgeRoot, "test"), { recursive: true });
      const srcPath = path.join(forgeRoot, "src", `${c.name}.sol`);
      if (!fs.existsSync(srcPath)) fs.writeFileSync(srcPath, emitted.find((e) => e.name === c.name)!.solidity, "utf8");
      fs.writeFileSync(path.join(forgeRoot, "test", `${c.name}.inv.t.sol`), sol, "utf8");
      emittedInvariants.set(c.name, invs.length);
    }
    if (emittedInvariants.size > 0 && !opts.noFuzzRun) {
      ensureForgeProject(forgeRoot);
      const forge2 = await resolveTool("forge");
      const r = spawnSync(forge2.cmd, [...forge2.argPrefix, "test", "--root", forgeRoot, "--match-contract", "InvariantAuto"], { stdio: "inherit" });
      const gate7Ok = r.status === 0;
      for (const [name, count] of emittedInvariants) {
        record(name, gate7Ok
          ? gatePassed("invariant-tests", `${count} invariant(s) hold`, count)
          : gateFailed("invariant-tests", `${count} invariant(s) emitted; forge invariant run failed`, count));
      }
      if (!gate7Ok) allResults.ok = false;
      reportGate(gate7Ok, gate7Ok ? "all invariants hold" : "an invariant was violated");
    } else {
      for (const [name, count] of emittedInvariants) {
        record(name, skipped("invariant-tests", `${count} invariant(s) emitted; run skipped (--skip fuzz-run)`));
      }
      reportGate(true, emittedInvariants.size > 0 ? "emitted (run skipped)" : "none declared");
    }
  }

  // Gate 9 — attestation
  banner("Gate 9/9 — attestation bundle");
  const tools = collectToolVersions();
  for (let i = 0; i < program.contracts.length; i++) {
    const contract = program.contracts[i]!;
    const solPath = path.join(solDir, `${contract.name}.sol`);
    const solSource = fs.readFileSync(solPath, "utf8");
    const tsHash = sha256(fs.readFileSync(contract.sourceFile, "utf8"));
    const solHash = sha256(solSource);
    const art = compileResult.artifacts.find((a) => a.contractName === contract.name);
    const gates = contractGates.get(contract.name)!;
    const bundle: AttestationBundle = {
      schemaVersion: 2,
      contract: contract.name,
      hashes: {
        tsSource: tsHash,
        solSource: solHash,
        bytecode: art ? sha256(art.bytecode) : undefined,
        deployedBytecode: art ? sha256(art.deployedBytecode) : undefined,
      },
      tools,
      gates,
      optimizations: optimizations.find((r) => r.contract === contract.name)?.changes ?? [],
      diagnostics: native.filter((d) => d.loc?.file === contract.sourceFile).map((d) => ({
        rule: d.rule,
        severity: d.severity,
        message: d.message,
      })),
      generatedAt: new Date().toISOString(),
      generatedBy: `scriipture@${tools.find((t) => t.name === "scriipture")?.version ?? "?"}`,
    };
    const dir = path.join(auditDir, contract.name);
    fs.mkdirSync(dir, { recursive: true });
    const attPath = path.join(dir, `${contract.name}.attestation.json`);
    const fingerprint = writeAttestation(attPath, bundle);
    allResults.attestations.push({ contract: contract.name, path: attPath, fingerprint });
    for (const g of gates) allResults.gates.push({ ...g, contract: contract.name });
    console.log(`  ${pc.cyan(contract.name)} → ${attPath}`);
    console.log(`    fingerprint: ${pc.dim(fingerprint.slice(0, 16) + "…")}`);
  }
  reportGate(true, `${allResults.attestations.length} attestation(s) written`);

  const skippedNames = Array.from(new Set(allResults.gates.filter((g) => g.status === "skipped" && !g.optIn).map((g) => g.name)));
  if (skippedNames.length > 0) {
    console.log(pc.yellow(`  ⚠ skipped gate(s) recorded as "skipped", not "passed": ${skippedNames.join(", ")}`));
    if (opts.skipJustification) console.log(pc.yellow(`    justification: ${opts.skipJustification}`));
  }

  console.log("");
  if (allResults.ok && skippedNames.length > 0 && !opts.skipJustification) {
    console.log(pc.bold(pc.green("✓ ALL GATES THAT RAN PASSED")) + pc.yellow(` — ${skippedNames.length} gate(s) skipped; secure-deploy will refuse without --allow-skipped-gates "<reason>"`));
  } else if (allResults.ok) {
    console.log(pc.bold(pc.green("✓ ALL GATES PASSED — contracts are clear for deploy")));
  } else {
    console.log(pc.bold(pc.red("✗ ONE OR MORE GATES FAILED — deploy is blocked")));
  }

  return allResults;
}

function banner(label: string): void {
  console.log("");
  console.log(pc.bold(pc.cyan(label)));
}
function reportGate(ok: boolean, msg: string): void {
  console.log(`  ${ok ? pc.green("✓") : pc.red("✗")} ${msg}`);
}

function ensureForgeProject(root: string): void {
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  const stdPath = path.join(root, "lib", "forge-std", "src", "Test.sol");
  if (!fs.existsSync(stdPath)) {
    spawnSync("git", ["clone", "--depth", "1", "https://github.com/foundry-rs/forge-std", path.join(root, "lib", "forge-std")], { stdio: "inherit" });
  }
  const toml = `[profile.default]
src = "src"
test = "test"
out = "out"
libs = ["lib"]
solc = "0.8.20"
optimizer = true
remappings = [
  "@openzeppelin/=${path.resolve("node_modules/@openzeppelin")}/",
  "forge-std/=lib/forge-std/src/"
]
`;
  fs.writeFileSync(path.join(root, "foundry.toml"), toml, "utf8");
}

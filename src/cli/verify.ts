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

export interface VerifyResult {
  ok: boolean;
  gates: GateResult[];
  attestations: Array<{ contract: string; path: string; fingerprint: string }>;
}

const GATE_NAMES = [
  "1-native-validator",
  "2-solc-compile",
  "3-smt-checker",
  "4-slither",
  "5-pattern-library",
  "6-fuzz-harness",
  "7-invariant-tests",
  "8-attestation",
];

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
  const optimizations = optimizeProgram(program);
  const emitted = emitProgram(program);

  for (const e of emitted) fs.writeFileSync(path.join(solDir, `${e.name}.sol`), e.solidity, "utf8");

  const allResults: VerifyResult = { ok: true, gates: [], attestations: [] };
  const contractGates = new Map<string, GateResult[]>();
  for (const c of program.contracts) contractGates.set(c.name, []);

  // Gate 1 — native validator (secure mode)
  banner("Gate 1/9 — native validator (secure mode)");
  const native = validateProgram(program, { secure: true });
  const nativeErrors = native.filter((d) => d.severity === "error");
  const gate1Ok = nativeErrors.length === 0;
  for (const c of program.contracts) {
    contractGates.get(c.name)!.push({
      name: "native-validator",
      passed: nativeErrors.filter((d) => d.loc?.file === c.sourceFile).length === 0,
      detail: `${native.length} diagnostic(s), ${nativeErrors.length} error(s)`,
      findings: native.length,
    });
  }
  if (!gate1Ok) allResults.ok = false;
  reportGate(gate1Ok, `${nativeErrors.length} error(s), ${native.length} total diagnostic(s)`);
  for (const d of nativeErrors) console.error(pc.red(`  ${d.loc?.file}:${d.loc?.line}: [${d.rule}] ${d.message}`));

  // Gate 2 — solc compile
  banner("Gate 2/9 — solc compile");
  const solFiles = emitted.map((e) => path.join(solDir, `${e.name}.sol`));
  const compileResult = compileSolidity({ solFiles, config });
  const gate2Ok = compileResult.errors.length === 0;
  for (const c of program.contracts) {
    contractGates.get(c.name)!.push({
      name: "solc-compile",
      passed: gate2Ok,
      detail: gate2Ok ? "clean" : `${compileResult.errors.length} compile error(s)`,
    });
  }
  if (!gate2Ok) allResults.ok = false;
  reportGate(gate2Ok, gate2Ok ? "clean" : `${compileResult.errors.length} error(s)`);
  for (const e of compileResult.errors.slice(0, 3)) console.error(pc.red(`  ${e.split("\n")[0]}`));

  // Gate 3 — SMTChecker
  banner("Gate 3/9 — SMTChecker");
  if (opts.noSmt) {
    reportGate(true, "skipped (--no-smt)");
    for (const c of program.contracts) contractGates.get(c.name)!.push({ name: "smt-checker", passed: true, detail: "skipped" });
  } else {
    const smtResult = compileSolidity({ solFiles, config, modelCheck: true });
    const smtErrors = smtResult.smtFindings.filter((f) => f.severity === "error");
    const gate3Ok = smtErrors.length === 0;
    for (const c of program.contracts) {
      const hits = smtResult.smtFindings.filter((f) => path.basename(f.file ?? "") === `${c.name}.sol`).length;
      contractGates.get(c.name)!.push({
        name: "smt-checker",
        passed: smtResult.smtFindings.filter((f) => f.severity === "error" && path.basename(f.file ?? "") === `${c.name}.sol`).length === 0,
        detail: `${hits} finding(s)`,
        findings: hits,
      });
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
    for (const c of program.contracts) contractGates.get(c.name)!.push({ name: "mythril", passed: true, detail: "skipped (not --deep)" });
  } else if (opts.noMythril) {
    reportGate(true, "skipped (--skip mythril)");
    for (const c of program.contracts) contractGates.get(c.name)!.push({ name: "mythril", passed: true, detail: "skipped" });
  } else if (!mythrilInstalled()) {
    reportGate(false, "mythril not installed — `pipx install mythril` or `docker pull mythril/myth`");
    allResults.ok = false;
    for (const c of program.contracts) contractGates.get(c.name)!.push({ name: "mythril", passed: false, detail: "not installed" });
  } else {
    const sourcemapsM = program.contracts.map((c) => {
      const sol = fs.readFileSync(path.join(solDir, `${c.name}.sol`), "utf8");
      return buildSourceMap(c, sol);
    });
    const r = await runMythril(solFiles, sourcemapsM, { timeout: opts.mythrilTimeout });
    const errors = r.diagnostics.filter((d) => d.severity === "error");
    const gateMOk = errors.length === 0;
    for (const c of program.contracts) {
      const myFindings = r.findings.filter((f) => f.solFile === `${c.name}.sol`);
      contractGates.get(c.name)!.push({
        name: "mythril",
        passed: myFindings.filter((f) => f.severity === "error").length === 0,
        detail: `${myFindings.length} finding(s)`,
        findings: myFindings.length,
      });
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
    for (const c of program.contracts) contractGates.get(c.name)!.push({ name: "slither", passed: true, detail: "skipped" });
  } else if (!slitherInstalled()) {
    reportGate(false, "slither not installed — brew install slither-analyzer");
    allResults.ok = false;
    for (const c of program.contracts) contractGates.get(c.name)!.push({ name: "slither", passed: false, detail: "not installed" });
  } else {
    const sourcemaps = program.contracts.map((c) => {
      const sol = fs.readFileSync(path.join(solDir, `${c.name}.sol`), "utf8");
      return buildSourceMap(c, sol);
    });
    const r = await runSlither(solFiles, sourcemaps);
    const errors = r.diagnostics.filter((d) => d.severity === "error");
    const gate4Ok = errors.length === 0;
    for (const c of program.contracts) {
      const myFindings = r.findings.filter((f) => f.solFile === `${c.name}.sol`);
      contractGates.get(c.name)!.push({
        name: "slither",
        passed: myFindings.filter((f) => f.severity === "error").length === 0,
        detail: `${myFindings.length} finding(s)`,
        findings: myFindings.length,
      });
    }
    if (!gate4Ok) allResults.ok = false;
    reportGate(gate4Ok, `${r.findings.length} finding(s), ${errors.length} high-severity`);
    for (const d of r.diagnostics.slice(0, 3)) {
      const tag = d.severity === "error" ? pc.red : pc.yellow;
      console.log(`  ${tag(`[${d.severity}]`)} ${d.rule}: ${d.message.split("\n")[0]}`);
    }
  }

  // Gate 5 — pattern library
  banner("Gate 6/9 — pattern library");
  if (opts.noPatterns) {
    reportGate(true, "skipped (--no-patterns)");
    for (const c of program.contracts) contractGates.get(c.name)!.push({ name: "pattern-library", passed: true, detail: "skipped" });
  } else {
    let gate5Ok = true;
    for (const c of program.contracts) {
      const r = checkPatterns(c);
      contractGates.get(c.name)!.push({
        name: "pattern-library",
        passed: r.ok,
        detail: r.ok ? "all bases/imports recognized" : r.findings.join("; "),
      });
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
    for (const c of program.contracts) contractGates.get(c.name)!.push({ name: "fuzz-harness", passed: true, detail: "skipped" });
  } else {
    fs.mkdirSync(path.join(forgeRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(forgeRoot, "test"), { recursive: true });
    for (const e of emitted) fs.writeFileSync(path.join(forgeRoot, "src", `${e.name}.sol`), e.solidity, "utf8");

    let generated = 0;
    for (const c of program.contracts) {
      const h = generateFuzzHarness(c);
      if (h) {
        fs.writeFileSync(path.join(forgeRoot, "test", h.filename), h.solidity, "utf8");
        generated++;
        contractGates.get(c.name)!.push({ name: "fuzz-harness-generated", passed: true, detail: h.filename });
      } else {
        contractGates.get(c.name)!.push({ name: "fuzz-harness-generated", passed: true, detail: "skipped (ctor needs args or no public methods)" });
      }
    }

    if (generated === 0 || opts.noFuzzRun) {
      reportGate(true, opts.noFuzzRun ? "generation only (--no-fuzz-run)" : "no harnesses to run");
      for (const c of program.contracts) contractGates.get(c.name)!.push({ name: "fuzz-run", passed: true, detail: "skipped" });
    } else {
      ensureForgeProject(forgeRoot);
      const runs = opts.fuzzRuns ?? 1000;
      const forge = await resolveTool("forge");
      const r = spawnSync(forge.cmd, [...forge.argPrefix, "test", "--root", forgeRoot, "--fuzz-runs", String(runs), "--match-contract", "FuzzAuto"], { stdio: "inherit" });
      const gate6Ok = r.status === 0;
      for (const c of program.contracts) {
        contractGates.get(c.name)!.push({
          name: "fuzz-run",
          passed: gate6Ok,
          detail: gate6Ok ? `${runs} runs/method clean` : "forge test failed",
        });
      }
      if (!gate6Ok) allResults.ok = false;
      reportGate(gate6Ok, `${generated} harness(es), ${runs} runs each`);
    }
  }

  // Gate 8 — invariant tests
  banner("Gate 8/9 — invariant tests");
  if (opts.noInvariants) {
    reportGate(true, "skipped (--no-invariants)");
    for (const c of program.contracts) contractGates.get(c.name)!.push({ name: "invariant-tests", passed: true, detail: "skipped" });
  } else {
    let anyInvariants = false;
    for (const c of program.contracts) {
      const invs = collectInvariants(c);
      if (invs.length === 0) {
        contractGates.get(c.name)!.push({ name: "invariant-tests", passed: true, detail: "no invariants declared" });
        continue;
      }
      const sol = renderInvariantTest(c, invs);
      if (!sol) {
        contractGates.get(c.name)!.push({ name: "invariant-tests", passed: true, detail: "constructor needs args; manual harness required" });
        continue;
      }
      fs.writeFileSync(path.join(forgeRoot, "test", `${c.name}.inv.t.sol`), sol, "utf8");
      anyInvariants = true;
      contractGates.get(c.name)!.push({
        name: "invariant-tests",
        passed: true,
        detail: `${invs.length} invariant(s) emitted`,
        findings: invs.length,
      });
    }
    if (anyInvariants && !opts.noFuzzRun) {
      ensureForgeProject(forgeRoot);
      const forge2 = await resolveTool("forge");
      const r = spawnSync(forge2.cmd, [...forge2.argPrefix, "test", "--root", forgeRoot, "--match-contract", "InvariantAuto"], { stdio: "inherit" });
      const gate7Ok = r.status === 0;
      if (!gate7Ok) allResults.ok = false;
      reportGate(gate7Ok, gate7Ok ? "all invariants hold" : "an invariant was violated");
    } else {
      reportGate(true, anyInvariants ? "emitted (run skipped)" : "none declared");
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
    const bundle: AttestationBundle = {
      schemaVersion: 1,
      contract: contract.name,
      hashes: {
        tsSource: tsHash,
        solSource: solHash,
        bytecode: art ? sha256(art.bytecode) : undefined,
        deployedBytecode: art ? sha256(art.deployedBytecode) : undefined,
      },
      tools,
      gates: contractGates.get(contract.name)!,
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
    console.log(`  ${pc.cyan(contract.name)} → ${attPath}`);
    console.log(`    fingerprint: ${pc.dim(fingerprint.slice(0, 16) + "…")}`);
  }
  reportGate(true, `${allResults.attestations.length} attestation(s) written`);

  console.log("");
  if (allResults.ok) {
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

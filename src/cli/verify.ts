import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pc from "picocolors";
import { parseContractFiles } from "../parser/parse";
import { emitProgram, sharedDefinitions } from "../emitter/emit";
import { optimizeProgram } from "../optimizer/passes";
import { buildSourceMap } from "../sourcemaps/emit";
import { validateProgram } from "../validator/rules";
import { parseDiagnosticsAsErrors } from "../validator/diagnostics";
import { loadConfig } from "../config/load";
import { compileSolidity, foundrySolcLine, resolveOZRoot, toolSolcVersion } from "../compiler/solc";
import { runSlither, slitherInstalled } from "../audit/slither";
import { runMythril, mythrilInstalled } from "../audit/mythril";
import { resolveTool } from "../runtime/tool-paths";
import { generateFuzzHarness } from "../security/fuzz-gen";
import {
  collectInvariants,
  renderInvariantTest,
  renderSmtInvariantHarness,
  classifyInvariantProofs,
  proofStatus,
  SMT_HARNESS_SUFFIX,
} from "../security/invariants";
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
  /**
   * Where gate 2's artifacts were written. `secure-deploy` deploys from here so
   * that what goes on chain is what the gates hashed.
   */
  artifactsDir: string;
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
  const artifactsDir = path.join(outDir, "artifacts");
  fs.mkdirSync(solDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });

  const { program, diagnostics: parseDiagnostics } = parseContractFiles(files);
  const optimizations = optimizeProgram(program, { reorderStorage: opts.reorderStorage });
  const emitted = emitProgram(program);
  const solcVersion = toolSolcVersion(emitted.map((e) => e.solidity), config.compiler.version);

  for (const e of emitted) fs.writeFileSync(path.join(solDir, `${e.name}.sol`), e.solidity, "utf8");

  const allResults: VerifyResult = { ok: true, gates: [], attestations: [], artifactsDir };
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
  // A parse diagnostic means something in the source could not be represented
  // at all, so the emitted Solidity does not say what the TypeScript said.
  // Those must fail the gate, not be dropped on the floor.
  const native = [...parseDiagnosticsAsErrors(parseDiagnostics), ...validateProgram(program, { secure: true })];
  const nativeErrors = native.filter((d) => d.severity === "error");
  const gate1Ok = nativeErrors.length === 0;
  for (const c of program.contracts) {
    // A diagnostic with no location cannot be attributed, so it counts against every contract.
    const mine = nativeErrors.filter((d) => !d.loc || d.loc.file === c.sourceFile).length;
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
  if (gate2Ok) {
    // Write what was just verified so `secure-deploy` cannot deploy anything else.
    fs.mkdirSync(artifactsDir, { recursive: true });
    for (const a of compileResult.artifacts) {
      fs.writeFileSync(path.join(artifactsDir, `${a.contractName}.json`), JSON.stringify(a, null, 2), "utf8");
    }
    fs.writeFileSync(path.join(artifactsDir, "solc-input.json"), compileResult.standardJsonInput, "utf8");
  }
  reportGate(gate2Ok, gate2Ok ? `clean — ${compileResult.artifacts.length} artifact(s) → ${artifactsDir}` : `${compileResult.errors.length} error(s)`);
  for (const e of compileResult.errors.slice(0, 3)) console.error(pc.red(`  ${e.split("\n")[0]}`));

  // Gate 3 — SMTChecker
  banner("Gate 3/9 — SMTChecker");
  if (opts.noSmt) {
    reportGate(true, "skipped (--no-smt)");
    recordAll(skipped("smt-checker", "skipped (--no-smt)"));
  } else {
    const smtResult = compileSolidity({ solFiles, config, modelCheck: true });
    const engine = engineLabel(smtResult.modelChecker);
    if (!smtResult.modelChecker?.ran) {
      // No solver ran: this is "never checked", not "0 findings".
      const reason = smtResult.modelChecker?.reason ?? "SMTChecker unavailable";
      reportGate(true, `skipped — ${reason}`, true);
      recordAll({ ...skipped("smt-checker", `skipped (${reason})`), engine });
    } else {
      // SMTChecker never emits solc severity "error", so the verdict comes from
      // the message: "happens here" is a counterexample, "might happen here" is unproved.
      // Only a proven assertion violation blocks: under Solidity 0.8 a proven
      // overflow is a revert, not corrupted state, so it is reported not gated.
      const violations = smtResult.smtFindings.filter((f) => f.severity === "error" && f.kind === "assertion");
      const arithmetic = smtResult.smtFindings.filter((f) => f.severity === "error" && f.kind !== "assertion");
      const unproved = smtResult.smtFindings.filter((f) => f.severity === "warning");
      const gate3Ok = violations.length === 0;
      console.log(pc.dim(`  engine: ${engine}`));
      for (const c of program.contracts) {
        const mine = smtResult.smtFindings.filter((f) => path.basename(f.file ?? "") === `${c.name}.sol`);
        const mineViolations = mine.filter((f) => f.severity === "error" && f.kind === "assertion").length;
        const mineArithmetic = mine.filter((f) => f.severity === "error" && f.kind !== "assertion").length;
        const mineUnproved = mine.filter((f) => f.severity === "warning").length;
        const detail = `${mineViolations} assertion violation(s), ${mineArithmetic} proven arithmetic revert(s), ${mineUnproved} unproved, ${mine.length} finding(s)`;
        record(c.name, {
          ...(mineViolations === 0 ? gatePassed("smt-checker", detail, mine.length) : gateFailed("smt-checker", detail, mine.length)),
          engine,
        });
      }
      if (!gate3Ok) allResults.ok = false;
      reportGate(gate3Ok, `${violations.length} assertion violation(s), ${arithmetic.length} proven arithmetic revert(s), ${unproved.length} unproved, ${smtResult.smtFindings.length} finding(s)`);
      for (const f of smtResult.smtFindings.slice(0, 3)) {
        const tag = f.severity === "error" ? pc.red : f.severity === "warning" ? pc.yellow : pc.dim;
        console.log(`  ${tag(`[${f.severity}]`)} ${f.message.split("\n")[0]}`);
      }
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
    const r = await runMythril(solFiles, sourcemapsM, { timeout: opts.mythrilTimeout, solcVersion });
    const errors = r.diagnostics.filter((d) => d.severity === "error");
    const gateMOk = errors.length === 0;
    for (const c of program.contracts) {
      const failure = r.failures.find((f) => f.file === `${c.name}.sol`);
      if (failure) {
        // Mythril produced nothing for this contract; "0 findings" would read as clean.
        record(c.name, skipped("mythril", `not analysed: ${failure.reason}`));
        continue;
      }
      const mine = r.findings.filter((f) => f.solFile === `${c.name}.sol`);
      const high = mine.filter((f) => f.severity === "error").length;
      const detail = `${mine.length} finding(s)`;
      record(c.name, high === 0 ? gatePassed("mythril", detail, mine.length) : gateFailed("mythril", detail, mine.length));
    }
    if (!gateMOk) allResults.ok = false;
    reportGate(gateMOk, `${r.findings.length} issue(s), ${errors.length} high-severity` + (r.failures.length > 0 ? `, ${r.failures.length} file(s) NOT analysed` : ""), r.failures.length > 0);
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
      const failure = r.failures.find((f) => f.file === `${c.name}.sol`);
      if (failure) {
        // Slither produced no usable analysis for this contract; "0 findings"
        // would be indistinguishable from a contract it looked at and cleared.
        record(c.name, skipped("slither", `not analysed: ${failure.reason}`));
        console.log(`  ${pc.yellow("⚠")} ${c.name}: slither did not analyse this file — ${failure.reason}`);
        continue;
      }
      const mine = r.findings.filter((f) => f.solFile === `${c.name}.sol`);
      const high = mine.filter((f) => f.severity === "error").length;
      const detail = `${mine.length} finding(s)`;
      record(c.name, high === 0 ? gatePassed("slither", detail, mine.length) : gateFailed("slither", detail, mine.length));
    }
    if (!gate4Ok) allResults.ok = false;
    reportGate(gate4Ok, `${r.findings.length} finding(s), ${errors.length} high-severity` + (r.failures.length > 0 ? `, ${r.failures.length} file(s) NOT analysed` : ""), r.failures.length > 0);
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
    const defs = sharedDefinitions(program);
    for (const c of program.contracts) {
      const h = generateFuzzHarness(c, defs.get(c.sourceFile)?.typeNames);
      if (h) {
        fs.writeFileSync(path.join(forgeRoot, "test", h.filename), h.solidity, "utf8");
        harnessed.add(c.name);
        record(c.name, gatePassed("fuzz-harness-generated", h.filename));
      } else {
        record(c.name, gateNotApplicable("fuzz-harness-generated", "nothing to fuzz: a library, a constructor that needs arguments, or no reachable method with fuzzable parameters"));
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
      const runs = opts.fuzzRuns ?? 1000;
      const forgeReady = ensureForgeProject(forgeRoot, foundrySolcLine(emitted.map((e) => e.solidity), config.compiler.version));
      const r = forgeReady
        ? await runForge(forgeRoot, ["--fuzz-runs", String(runs), "--match-contract", "FuzzAuto"])
        : { status: null as number | null };
      const gate6Ok = r.status === 0;
      const failDetail = forgeReady ? "forge test failed — a fuzz run reverted or forge could not compile (see output)" : FORGE_STD_MISSING;
      for (const c of program.contracts) {
        if (!harnessed.has(c.name)) {
          record(c.name, gateNotApplicable("fuzz-run", "no harness generated"));
        } else {
          record(c.name, gate6Ok ? gatePassed("fuzz-run", `${runs} runs/method clean`) : gateFailed("fuzz-run", failDetail));
        }
      }
      if (!gate6Ok) allResults.ok = false;
      reportGate(gate6Ok, gate6Ok ? `${harnessed.size} harness(es), ${runs} runs each` : failDetail);
    }
  }

  // Gate 8 — invariant tests: forge fuzzing (evidence) + SMTChecker proof attempt
  banner("Gate 8/9 — invariant tests");
  if (opts.noInvariants) {
    reportGate(true, "skipped (--no-invariants)");
    recordAll(skipped("invariant-tests", "skipped (--no-invariants)"));
    recordAll(skipped("invariant-proof", "skipped (--no-invariants)"));
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
      // Always refresh: gate 7 writes these files too, but it is skipped under
      // `--skip fuzz`, and out/forge persists across runs, so an existing copy
      // may be from a previous version of the contract. Every file, because
      // the contract imports its bases, interfaces and shared definitions.
      for (const e of emitted) fs.writeFileSync(path.join(forgeRoot, "src", `${e.name}.sol`), e.solidity, "utf8");
      fs.writeFileSync(path.join(forgeRoot, "test", `${c.name}.inv.t.sol`), sol, "utf8");
      emittedInvariants.set(c.name, invs.length);
    }
    if (emittedInvariants.size > 0 && !opts.noFuzzRun) {
      const forgeReady = ensureForgeProject(forgeRoot, foundrySolcLine(emitted.map((e) => e.solidity), config.compiler.version));
      const r = forgeReady
        ? await runForge(forgeRoot, ["--match-contract", "InvariantAuto"])
        : { status: null as number | null };
      const gate7Ok = r.status === 0;
      // forge's exit code does not separate "assertion failed" from "could not compile / no forge-std";
      // say so instead of announcing a violation that may not exist.
      const failDetail = forgeReady
        ? "forge invariant run failed — a violation was found or forge could not compile (see output)"
        : FORGE_STD_MISSING;
      for (const [name, count] of emittedInvariants) {
        record(name, gate7Ok
          ? gatePassed("invariant-tests", `${count} invariant(s) held under forge fuzzing`, count)
          : gateFailed("invariant-tests", `${count} invariant(s) emitted; ${failDetail}`, count));
      }
      if (!gate7Ok) allResults.ok = false;
      reportGate(gate7Ok, gate7Ok ? "all invariants held under forge fuzzing" : failDetail);
    } else {
      for (const [name, count] of emittedInvariants) {
        record(name, skipped("invariant-tests", `${count} invariant(s) emitted; run skipped (--skip fuzz-run)`));
      }
      reportGate(true, emittedInvariants.size > 0 ? "emitted (run skipped)" : "none declared");
    }

    // Proof attempt: assert each invariant inside a harness that inherits the
    // contract and let solc's CHC engine try to prove it over all reachable states.
    for (const c of program.contracts) {
      const invs = collectInvariants(c);
      const harness = renderSmtInvariantHarness(c, invs);
      if (!harness) {
        record(c.name, gateNotApplicable("invariant-proof", invs.length === 0 ? "no invariants declared" : "constructor needs args; manual harness required"));
        continue;
      }
      if (opts.noSmt) {
        record(c.name, skipped("invariant-proof", `${invs.length} invariant(s) not proven (--no-smt)`));
        continue;
      }
      // Not out/sol: `compile out/sol` globs *.sol and would build the harness
      // into a deployable artifact, and Slither would audit it as a contract.
      const smtDir = path.join(outDir, "smt");
      fs.mkdirSync(smtDir, { recursive: true });
      const harnessFile = `${c.name}${SMT_HARNESS_SUFFIX}.sol`;
      const harnessPath = path.join(smtDir, harnessFile);
      fs.writeFileSync(harnessPath, harness, "utf8");
      const r = compileSolidity({ solFiles: [path.join(solDir, `${c.name}.sol`), harnessPath], config, modelCheck: true });
      const proofEngine = engineLabel(r.modelChecker);
      if (!r.modelChecker?.ran) {
        const reason = r.modelChecker?.reason ?? "SMTChecker unavailable";
        record(c.name, { ...skipped("invariant-proof", `${invs.length} invariant(s) not proven: ${reason}`), engine: proofEngine });
        console.log(`  ${pc.yellow("⚠")} ${c.name}: SMT proof skipped — ${reason}`);
        continue;
      }
      const verdict = classifyInvariantProofs(invs, harness, r.smtFindings, harnessFile);
      const summary = `${verdict.proven.length}/${invs.length} proven by SMTChecker` +
        (verdict.unproven.length > 0 ? `; unproven (solver gave up): ${verdict.unproven.join(", ")}` : "") +
        (verdict.violated.length > 0 ? `; VIOLATED: ${verdict.violated.join(", ")}` : "");
      switch (proofStatus(verdict, invs)) {
        case "failed":
          record(c.name, { ...gateFailed("invariant-proof", summary, verdict.violated.length), engine: proofEngine });
          allResults.ok = false;
          reportGate(false, `${c.name}: ${summary}`);
          break;
        case "skipped":
          // The solver settled nothing. "passed" would read as "proved".
          record(c.name, { ...skipped("invariant-proof", `${summary} — the solver settled none of them`), engine: proofEngine });
          reportGate(true, `${c.name}: ${summary} (recorded as skipped, not proved)`);
          break;
        default:
          record(c.name, { ...gatePassed("invariant-proof", summary, verdict.unproven.length), engine: proofEngine });
          reportGate(true, `${c.name}: ${summary}`);
      }
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

/** "native-solc 0.8.37+commit.f401782d", or undefined when nothing ran. */
function engineLabel(status: { engine?: string; version?: string } | undefined): string | undefined {
  if (!status?.engine) return undefined;
  return `${status.engine}${status.version ? ` ${status.version}` : ""}`;
}

function banner(label: string): void {
  console.log("");
  console.log(pc.bold(pc.cyan(label)));
}
function reportGate(ok: boolean, msg: string, partial = false): void {
  const mark = !ok ? pc.red("✗") : partial ? pc.yellow("⚠") : pc.green("✓");
  console.log(`  ${mark} ${msg}`);
}

const FORGE_STD_MISSING = "forge-std could not be fetched (git clone failed — offline?); forge did not run";

async function runForge(root: string, args: string[]): Promise<{ status: number | null }> {
  const forge = await resolveTool("forge");
  const r = spawnSync(forge.cmd, [...forge.argPrefix, "test", "--root", root, ...args], { stdio: "inherit", env: process.env });
  return { status: r.status };
}

/** Prepare the forge project; returns false when forge-std is unavailable, in which case forge cannot run. */
function ensureForgeProject(root: string, solcLine: string): boolean {
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  const stdPath = path.join(root, "lib", "forge-std", "src", "Test.sol");
  if (!fs.existsSync(stdPath)) {
    const dest = path.join(root, "lib", "forge-std");
    fs.rmSync(dest, { recursive: true, force: true }); // a half-cloned tree from an earlier failure
    spawnSync("git", ["clone", "--depth", "1", "https://github.com/foundry-rs/forge-std", dest], { stdio: "inherit", env: process.env });
  }
  // Resolve OpenZeppelin the same way the compiler does, so this works when
  // scriipture is an installed dependency and node_modules is not in cwd.
  const ozRoot = resolveOZRoot();
  const ozRemap = ozRoot
    ? `"@openzeppelin/contracts/=${ozRoot}/",`
    : `"@openzeppelin/=${path.resolve("node_modules/@openzeppelin")}/",`;
  const toml = `[profile.default]
src = "src"
test = "test"
out = "out"
libs = ["lib"]
${solcLine}optimizer = true
remappings = [
  ${ozRemap}
  "forge-std/=lib/forge-std/src/"
]
`;
  fs.writeFileSync(path.join(root, "foundry.toml"), toml, "utf8");
  return fs.existsSync(stdPath);
}

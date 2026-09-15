import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseContractFiles } from "../src/parser/parse";
import { emitProgram } from "../src/emitter/emit";
import { collectInvariants, renderSmtInvariantHarness, classifyInvariantProofs } from "../src/security/invariants";
import { compileSolidity, nativeSolc } from "../src/compiler/solc";
import { ConfigSchema } from "../src/config/schema";

const ROOT = path.resolve(__dirname, "..");

describe("gate 8 — SMTChecker invariant proofs", () => {
  it("renders a harness that inherits the contract and asserts each invariant", () => {
    const { program } = parseContractFiles([path.join(ROOT, "examples/yield-vault/YieldVault.ts")]);
    const c = program.contracts[0]!;
    const invs = collectInvariants(c);
    expect(invs.map((i) => i.selfPredicate)).toEqual(["invariantStakeBalances()", "invariantRewardsNonNegative()"]);
    const sol = renderSmtInvariantHarness(c, invs)!;
    expect(sol).toContain('import "./YieldVault.sol";');
    expect(sol).toContain("contract YieldVaultSmtHarness is YieldVault {");
    expect(sol).toContain("assert(invariantStakeBalances());");
    expect(sol).toContain("assert(invariantRewardsNonNegative());");
  });

  it("classifies solver output per invariant", () => {
    const { program } = parseContractFiles([path.join(ROOT, "examples/yield-vault/YieldVault.ts")]);
    const c = program.contracts[0]!;
    const invs = collectInvariants(c);
    const sol = renderSmtInvariantHarness(c, invs)!;
    const lineOf = (needle: string) => sol.split("\n").findIndex((l) => l.includes(needle)) + 1;
    const verdict = classifyInvariantProofs(invs, sol, [
      { message: "CHC: Assertion violation happens here.", line: lineOf("assert(invariantStakeBalances())"), file: "YieldVaultSmtHarness.sol" },
      { message: "CHC: Assertion violation might happen here.", line: lineOf("assert(invariantRewardsNonNegative())"), file: "YieldVaultSmtHarness.sol" },
      { message: "CHC: Assertion violation happens here.", line: 3, file: "YieldVault.sol" }, // not the harness
    ], "YieldVaultSmtHarness.sol");
    expect(verdict.violated).toEqual(["invariantStakeBalances"]);
    expect(verdict.unproven).toEqual(["invariantRewardsNonNegative"]);
    expect(verdict.proven).toEqual([]);
  });

  it("never reports a clean SMT run when no solver executed", () => {
    const { program } = parseContractFiles([path.join(ROOT, "examples/counter/Counter.ts")]);
    const sol = emitProgram(program)[0]!.solidity;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-smt-"));
    const file = path.join(dir, "Counter.sol");
    fs.writeFileSync(file, sol, "utf8");
    const r = compileSolidity({ solFiles: [file], config: ConfigSchema.parse({}), modelCheck: true });
    expect(r.modelChecker).toBeDefined();
    if (nativeSolc()) {
      expect(r.modelChecker!.ran).toBe(true);
      expect(r.modelChecker!.engine).toBe("native-solc");
    } else {
      expect(r.modelChecker!.ran).toBe(false);
      expect(r.modelChecker!.reason).toMatch(/solc/i);
      expect(r.errors).toEqual([]); // the solver failure is a status, not a compile error
    }
  }, 60_000);
});

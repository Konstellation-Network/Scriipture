import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseContractFiles } from "../src/parser/parse";
import { emitProgram } from "../src/emitter/emit";
import { optimizeProgram } from "../src/optimizer/passes";
import { validateProgram, RULE_IDS } from "../src/validator/rules";
import { compileSolidity } from "../src/compiler/solc";
import { ConfigSchema } from "../src/config/schema";

const ROOT = path.resolve(__dirname, "..");

function build(fixture: string) {
  const { program, diagnostics } = parseContractFiles([path.join(ROOT, fixture)]);
  optimizeProgram(program);
  return { program, diagnostics, emitted: emitProgram(program) };
}

/** Compile every contract a fixture produces, together, as `verify` does. */
function compileAll(name: string, emitted: Array<{ name: string; solidity: string }>): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `scriipture-${name}-`));
  const files = emitted.map((e) => {
    const f = path.join(dir, `${e.name}.sol`);
    fs.writeFileSync(f, e.solidity, "utf8");
    return f;
  });
  return compileSolidity({ solFiles: files, config: ConfigSchema.parse({}) }).errors;
}

describe("constructs the transpiler cannot lower are reported, not dropped", () => {
  const messages = () => build("tests/contracts/Unsupported.ts").diagnostics.map((d) => d.message);

  it("reports accessors instead of deleting them", () => {
    // Dropping these removed code, and the `constant` pass then saw a state
    // variable nothing assigned and froze it: the contract could never change.
    expect(messages().filter((m) => m.includes('getter "current"'))).toHaveLength(1);
    expect(messages().filter((m) => m.includes('setter "current"'))).toHaveLength(1);
  });

  it("reports parameter forms Solidity does not have", () => {
    expect(messages().some((m) => m.includes('"b" is optional'))).toBe(true);
    expect(messages().some((m) => m.includes('"a" has a default value'))).toBe(true);
    expect(messages().some((m) => m.includes('"vals" is a rest parameter'))).toBe(true);
  });

  it("reports statements that would otherwise be emitted as TypeScript text", () => {
    expect(messages().some((m) => m.includes("`switch` statement"))).toBe(true);
    expect(messages().some((m) => m.includes("`do … while` loop"))).toBe(true);
    expect(messages().some((m) => m.includes("`try` / `catch` block"))).toBe(true);
  });

  it("reports a static member", () => {
    expect(messages().some((m) => m.includes('"VERSION" is static'))).toBe(true);
  });

  it("reports an unknown base contract", () => {
    const { program } = build("tests/contracts/Unsupported.ts");
    program.contracts[0]!.bases.push("SomeLibraryContract");
    const errors = validateProgram(program).filter((d) => d.rule === "unknown-base-contract");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe("error");
  });
});

describe("break and continue are real statements, not passthrough text", () => {
  it("emits them and compiles", () => {
    const { diagnostics, emitted } = build("tests/contracts/Loops.ts");
    expect(diagnostics).toEqual([]);
    expect(emitted[0]!.solidity).toContain("continue;");
    expect(emitted[0]!.solidity).toContain("break;");
    expect(compileAll("loops", emitted)).toEqual([]);
  }, 60_000);
});

describe("TypeScript visibility keywords reach the emitted contract", () => {
  const built = () => build("tests/contracts/TsVisibility.ts");

  it("maps private to private and protected to internal", () => {
    const sol = built().emitted[0]!.solidity;
    expect(sol).toContain("uint256 private constant secret = 42;");
    expect(sol).toContain("uint256 internal constant guarded = 7;");
    expect(sol).toMatch(/function double\(uint256 v\) private/);
    expect(sol).toMatch(/function internalOnly\(\) internal/);
  });

  it("keeps them out of the external ABI", () => {
    const { emitted } = built();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-vis-"));
    const f = path.join(dir, "TsVisibility.sol");
    fs.writeFileSync(f, emitted[0]!.solidity, "utf8");
    const r = compileSolidity({ solFiles: [f], config: ConfigSchema.parse({}) });
    expect(r.errors).toEqual([]);
    const abi = r.artifacts.find((a) => a.contractName === "TsVisibility")!.abi as Array<{ type: string; name?: string }>;
    const callable = abi.filter((e) => e.type === "function").map((e) => e.name).sort();
    expect(callable).toEqual(["add", "readTotal", "total"]);
  }, 60_000);
});

describe("a base contract defined in the same build", () => {
  it("is imported, so the child compiles", () => {
    const { diagnostics, emitted } = build("tests/contracts/Inheritance.ts");
    expect(diagnostics).toEqual([]);
    const child = emitted.find((e) => e.name === "CappedLedger")!.solidity;
    expect(child).toContain('import "./Ledger.sol";');
    expect(child).toContain("contract CappedLedger is Ledger {");
    expect(compileAll("inherit", emitted)).toEqual([]);
  }, 60_000);
});

describe("string operators", () => {
  it("lower to a hash comparison and a concat, and compile", () => {
    const { emitted } = build("tests/contracts/StringOps.ts");
    const sol = emitted[0]!.solidity;
    expect(sol).toContain("return keccak256(bytes(name)) == keccak256(bytes(other));");
    expect(sol).toContain("return keccak256(bytes(name)) != keccak256(bytes(other));");
    expect(sol).toContain("name = string.concat(name, suffix);");
    // `+=` has no Solidity form for a string any more than `+` does
    expect(sol).toContain("name = string.concat(name, extra);");
    // a string literal on one side is fine: bytes("abc") is a legal conversion
    expect(sol).toContain('return keccak256(bytes(name)) == keccak256(bytes("abc"));');
    expect(compileAll("strings", emitted)).toEqual([]);
  }, 60_000);
});

describe("overloads keep their own mutation analysis", () => {
  it("gives calldata to the read-only overload and memory to the writing one", () => {
    // Keyed by name, the writing overload's mutation set was applied to both.
    const sol = build("tests/contracts/OverloadedMutation.ts").emitted[0]!.solidity;
    expect(sol).toContain("function apply(uint256[] calldata xs) external view");
    expect(sol).toContain("function apply(uint256[] memory xs, uint256 n) external");
  });
});

describe("the documented rule count cannot drift from the code", () => {
  it("RULE_IDS lists every rule identifier the validator can emit", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/validator/rules.ts"), "utf8");
    const emitted = new Set([...src.matchAll(/rule: "([a-z0-9-]+)"/g)].map((m) => m[1]!));
    // Built with a ternary rather than a literal `rule:` field.
    emitted.add("view-no-mutate");
    emitted.add("pure-no-mutate");
    expect([...emitted].sort()).toEqual([...RULE_IDS].sort());
  });

  it("is the number the docs quote", () => {
    for (const doc of ["README.md", "LANDING.md", "docs/details.md"]) {
      const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
      const counts = [...text.matchAll(/(\d+) (?:native )?rules/g)].map((m) => Number(m[1]));
      expect(counts.length).toBeGreaterThan(0);
      for (const c of counts) expect(c).toBe(RULE_IDS.length);
    }
  });
});

describe("expressions the transpiler cannot lower are reported too", () => {
  const messages = () => build("tests/contracts/UnsupportedExpr.ts").diagnostics.map((d) => d.message);

  it("reports a populated array literal, which used to reach solc as `[1n, 2n, 3n]`", () => {
    expect(messages().some((m) => m.includes("array literal"))).toBe(true);
  });

  it("reports operators and keywords with no Solidity form", () => {
    expect(messages().some((m) => m.includes("`typeof`"))).toBe(true);
    expect(messages().some((m) => m.includes('the ">>>" operator'))).toBe(true);
    expect(messages().some((m) => m.includes("`undefined`"))).toBe(true);
  });

  it("leaves an empty array literal alone, because that is how an array state var is initialised", () => {
    // Five bundled fixtures rely on it, and the emitter drops the initializer.
    const { diagnostics } = build("tests/contracts/Loops.ts");
    expect(diagnostics).toEqual([]);
  });
});

describe("a local holding a struct value is typed as one", () => {
  it("types a struct literal and a call to an own function that returns a struct", () => {
    // Without this the `uint256` fallback emits `uint256 p = Proposal({…})`.
    // Fixed once on the base branch in a file the later rounds rewrote, so it
    // is asserted here to stop the capability being lost in a merge.
    const { diagnostics, emitted } = build("tests/contracts/StructLocal.ts");
    expect(diagnostics).toEqual([]);
    const sol = emitted[0]!.solidity;
    expect(sol).toContain("Proposal memory p = Proposal({id: 1, owner: msg.sender});");
    expect(sol).toContain("Proposal memory q = draft(id);");
    expect(compileAll("structlocal", emitted)).toEqual([]);
  }, 60_000);
});

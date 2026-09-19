import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseContractFiles } from "../src/parser/parse";
import { emitProgram } from "../src/emitter/emit";
import { optimizeProgram } from "../src/optimizer/passes";
import { validateProgram } from "../src/validator/rules";
import { compileSolidity } from "../src/compiler/solc";
import { ConfigSchema } from "../src/config/schema";
import { generateFuzzHarness } from "../src/security/fuzz-gen";

const ROOT = path.resolve(__dirname, "..");
const FIXTURE = path.join(ROOT, "tests/contracts/Lowering.ts");

function build(optimize = true) {
  const { program, diagnostics } = parseContractFiles([FIXTURE]);
  if (optimize) optimizeProgram(program);
  return { program, diagnostics, sol: emitProgram(program)[0]!.solidity };
}

describe("calldata-params actually emits calldata", () => {
  it("marks read-only reference params calldata and written ones memory", () => {
    const { sol } = build();
    expect(sol).toContain("function greet(string calldata name)");
    expect(sol).toContain("function first(uint256[] calldata values)");
    expect(sol).toContain("function bump(uint256[] memory values)");
  });

  it("returns keep memory", () => {
    const { sol } = build();
    expect(sol).toContain("returns (string memory)");
  });
});

describe("?? lowering", () => {
  it("drops a default-value fallback", () => {
    const { sol } = build();
    expect(sol).toContain("return balances[who];");
  });

  it("emits an explicit test for a non-default fallback, per type", () => {
    const { sol } = build();
    expect(sol).toContain("return (balances[who] == 0 ? 1 : balances[who]);");
    expect(sol).toContain("return (delegate == address(0) ? msg.sender : delegate);");
    expect(sol).toContain('return (bytes(names[who]).length == 0 ? "anon" : names[who]);');
    expect(sol).toContain("return (!paused ? true : paused);");
  });

  it("is an error when the fallback would be dropped", () => {
    const { program } = parseContractFiles([path.join(ROOT, "tests/contracts/BadLowering.ts")]);
    const diags = validateProgram(program);
    const nullish = diags.filter((d) => d.rule === "nullish-fallback");
    expect(nullish).toHaveLength(1);
    expect(nullish[0]!.severity).toBe("error");
    const shape = diags.filter((d) => d.rule === "destructure-shape");
    expect(shape).toHaveLength(1);
    expect(shape[0]!.message).toContain("tuple type annotation");
  });

  it("types an element of a parameter array, so the fallback is not dropped", () => {
    const { sol } = build();
    expect(sol).toContain("return (addrs[0] == address(0) ? msg.sender : addrs[0]);");
  });

  it("agrees with the emitter about destructured locals (no false error)", () => {
    const { program, sol } = build();
    expect(sol).toContain("return b ? (a == 0 ? 5 : a) : 0;");
    const errors = validateProgram(program).filter((d) => d.rule === "nullish-fallback" && d.severity === "error");
    expect(errors).toEqual([]);
  });

  it("is only informational when it lowers cleanly", () => {
    const { program } = build();
    const diags = validateProgram(program).filter((d) => d.rule === "nullish-fallback");
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.every((d) => d.severity === "info")).toBe(true);
  });
});

describe("tuple destructuring", () => {
  it("lowers low-level call results with omitted and named slots", () => {
    const { sol } = build();
    expect(sol).toContain('(bool ok, ) = safe.call("");');
    expect(sol).toContain('(bool ok, bytes memory data) = safe.call("");');
  });

  it("uses a tuple annotation when given", () => {
    const { sol } = build();
    expect(sol).toContain("(uint256 a, bool b) = twoValues();");
  });

  it("no longer trips the unchecked-low-level-call rule when the result is bound", () => {
    const { program } = build(false);
    const diags = validateProgram(program).filter((d) => d.rule === "no-unchecked-low-level-call");
    expect(diags).toEqual([]);
  });

  it("the whole fixture compiles under solc", () => {
    const { sol, diagnostics } = build();
    expect(diagnostics).toEqual([]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-lowering-"));
    const file = path.join(dir, "Lowering.sol");
    // the `solidity` template helper returns a tuple; give solc a real signature for it
    const patched = sol.replace(/function twoValues\(\) public view returns \(any[^)]*\)/, "function twoValues() public pure returns (uint256, bool)");
    fs.writeFileSync(file, patched, "utf8");
    const r = compileSolidity({ solFiles: [file], config: ConfigSchema.parse({}) });
    expect(r.errors).toEqual([]);
  }, 60_000);
});

describe("fuzz harness with struct params", () => {
  it("passes structs as memory", () => {
    const { program } = parseContractFiles([path.join(ROOT, "tests/contracts/Governance.ts")]);
    const h = generateFuzzHarness(program.contracts[0]!)!;
    expect(h.solidity).toContain("function testFuzz_ProposalOf(uint256 id) public");
    expect(h.solidity).not.toContain("Proposal calldata");
  });
});

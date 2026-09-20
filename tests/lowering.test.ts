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
import { collectLocalTypes, typeEnvFor } from "../src/mapper/infer";

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
    const nullish = diags.filter((d) => d.rule === "nullish-fallback" && d.message.includes("not testable"));
    expect(nullish).toHaveLength(1);
    expect(nullish[0]!.severity).toBe("error");
    const shape = diags.filter((d) => d.rule === "destructure-shape");
    expect(shape).toHaveLength(1);
    expect(shape[0]!.message).toContain("tuple type annotation");
  });

  it("tests a CheckedAddress as the address it is emitted as", () => {
    const { program } = parseContractFiles([path.join(ROOT, "tests/contracts/CheckedFallback.ts")]);
    const sol = emitProgram(program)[0]!.solidity;
    expect(sol).toContain("return (owners[id] == address(0) ? msg.sender : owners[id]);");
    expect(sol).toContain("return (to == address(0) ? msg.sender : to);");
    const diags = validateProgram(program).filter((d) => d.rule === "nullish-fallback");
    expect(diags.map((d) => d.severity)).toEqual(["info", "info"]);
  });

  it("is an error when the left side has side effects, since the lowering evaluates it twice", () => {
    const { program } = parseContractFiles([path.join(ROOT, "tests/contracts/BadLowering.ts")]);
    const diags = validateProgram(program).filter((d) => d.rule === "nullish-fallback" && d.message.includes("side effects"));
    expect(diags.map((d) => d.severity)).toEqual(["error", "error"]);
    expect(diags.map((d) => d.message)).toEqual([
      expect.stringContaining('"next"'),
      expect.stringContaining('"nextAt"'),
    ]);
  });

  it("types an untyped local from its initializer, so the validator and the emitter agree", () => {
    const { program } = parseContractFiles([path.join(ROOT, "tests/contracts/StorageRefs.ts")]);
    const sol = emitProgram(program)[0]!.solidity;
    expect(sol).toContain("uint256 b = balances[who];");
    expect(sol).toContain("return (b == 0 ? 7 : b);");
    expect(sol).toContain("string memory s = names[who];");
    expect(sol).toContain("return bytes(s).length;");
    const errors = validateProgram(program).filter((d) => d.severity === "error");
    expect(errors).toEqual([]);
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

describe("locals bound to storage paths", () => {
  const FIXTURE_REFS = path.join(ROOT, "tests/contracts/StorageRefs.ts");
  const solOf = () => emitProgram(parseContractFiles([FIXTURE_REFS]).program)[0]!.solidity;

  it("keeps a struct reached through a mapping read in storage", () => {
    expect(solOf()).toContain("Meta storage m = proposals[id].meta;");
  });

  it("keeps a struct reached through a storage-pointer local in storage", () => {
    const sol = solOf();
    expect(sol).toContain("Proposal storage p = items[i];");
    expect(sol).toContain("Meta storage m = p.meta;");
  });

  it("keeps an array field in storage, so push reaches the chain", () => {
    expect(solOf()).toContain("uint256[] storage tags = proposals[id].tags;");
  });

  it("copies a value-typed field", () => {
    expect(solOf()).toContain("uint256 v = proposals[id].meta.votes;");
  });

  it("the fixture compiles under solc", () => {
    const { program, diagnostics } = parseContractFiles([FIXTURE_REFS]);
    expect(diagnostics).toEqual([]);
    optimizeProgram(program);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-storagerefs-"));
    const file = path.join(dir, "StorageRefs.sol");
    fs.writeFileSync(file, emitProgram(program)[0]!.solidity, "utf8");
    const r = compileSolidity({ solFiles: [file], config: ConfigSchema.parse({}) });
    expect(r.errors).toEqual([]);
  }, 60_000);
});

describe("block-scoped locals", () => {
  const FIXTURE_SCOPED = path.join(ROOT, "tests/contracts/ScopedLocals.ts");
  const solOf = () => emitProgram(parseContractFiles([FIXTURE_SCOPED]).program)[0]!.solidity;

  it("types a same-named local per branch, storage first", () => {
    const sol = solOf();
    const [voteBody] = sol.split("function voteRev");
    expect(voteBody).toContain("Proposal storage p = proposals[id];\n            Meta storage m = p.meta;");
    expect(voteBody).toContain("Proposal memory p = other;\n            Meta memory m = p.meta;");
  });

  it("types a same-named local per branch, memory first", () => {
    const sol = solOf();
    const voteRevBody = sol.split("function voteRev")[1]!.split("function voteEither")[0]!;
    expect(voteRevBody).toContain("Proposal memory p = other;\n            Meta memory m = p.meta;");
    expect(voteRevBody).toContain("Proposal storage p = proposals[id];\n            Meta storage m = p.meta;");
  });

  it("binds a ternary of two storage paths as a storage pointer", () => {
    expect(solOf()).toContain("Proposal storage p = useA ? proposals[1] : proposals[2];");
  });

  it("reports a struct from a ternary that mixes storage and memory, and does not type it", () => {
    // Neither binding is faithful: the validator says so and the emitter does not guess a struct.
    const { program } = parseContractFiles([path.join(ROOT, "tests/contracts/MixedTernary.ts")]);
    const sol = emitProgram(program)[0]!.solidity;
    expect(sol).not.toContain("Proposal memory p = useA");
    expect(sol).not.toContain("Proposal storage p = useA");
    const diags = validateProgram(program).filter((d) => d.rule === "storage-alias");
    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe("error");
    expect(diags[0]!.message).toContain('"p" in "vote"');
  });

  it("does not report a ternary of two storage paths or of two memory values", () => {
    const { program } = parseContractFiles([FIXTURE_SCOPED]);
    expect(validateProgram(program).filter((d) => d.rule === "storage-alias")).toEqual([]);
  });

  it("scopes a loop variable to its loop", () => {
    expect(solOf()).toContain("for (uint256 i = 0; i < n; i++) {");
  });

  it("collectLocalTypes still lists every local flat, for tooling", () => {
    const { program } = parseContractFiles([FIXTURE_SCOPED]);
    const count = program.contracts[0]!.functions.find((f) => f.name === "count")!;
    const types = collectLocalTypes(count, typeEnvFor(program.contracts[0]!, count));
    expect([...types.keys()].sort()).toEqual(["i", "n", "total"]);
  });

  it("the fixture compiles under solc", () => {
    const { program, diagnostics } = parseContractFiles([FIXTURE_SCOPED]);
    expect(diagnostics).toEqual([]);
    optimizeProgram(program);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-scoped-"));
    const file = path.join(dir, "ScopedLocals.sol");
    fs.writeFileSync(file, emitProgram(program)[0]!.solidity, "utf8");
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

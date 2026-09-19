import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseContractFiles } from "../src/parser/parse";
import { emitProgram } from "../src/emitter/emit";
import { optimizeProgram } from "../src/optimizer/passes";
import { compileSolidity } from "../src/compiler/solc";
import { ConfigSchema } from "../src/config/schema";

const ROOT = path.resolve(__dirname, "..");

function build(file: string): string {
  const { program } = parseContractFiles([path.join(ROOT, file)]);
  optimizeProgram(program);
  return emitProgram(program)[0]!.solidity;
}

describe("calldata-params only where calldata is legal", () => {
  const sol = () => build("tests/contracts/Calldata.ts");

  it("uses calldata for reference params of functions nothing calls internally", () => {
    expect(sol()).toContain("function greet(string calldata name) external view");
    expect(sol()).toContain("function sum(uint256[] calldata values) external view");
  });

  it("keeps memory on a function that is called from inside the contract", () => {
    // `nameLength` passes a storage string to `len`; a calldata param would not compile.
    expect(sol()).toContain("function len(string memory s) public view");
    expect(sol()).toContain("len(names[who])");
  });

  it("keeps memory when the parameter is written through an index", () => {
    expect(sol()).toContain("function clearFirst(uint256[] memory values) external");
    expect(sol()).toContain("delete values[0];");
  });

  it("sees a push through an element and a write through an index as mutations", () => {
    const s = build("tests/contracts/CalldataMutation.ts");
    expect(s).toContain("function addRow(uint256[][] memory rows) external");
    expect(s).toContain("function touch(string[] memory words) external");
  });

  it("keeps memory on a param that shares a ?? or ?: branch with a storage value", () => {
    // solc unifies memory with a storage pointer in a ternary, but not calldata.
    const s = build("tests/contracts/CalldataNullish.ts");
    expect(s).toContain("function nameOr(address who, string memory fb) external view");
    expect(s).toContain("function pick(address who, string memory fb, bool useFb) external view");
    // a value-typed element and a literal sibling are fine
    expect(s).toContain("function firstOr(uint256[] calldata xs) external view");
    expect(s).toContain("function greet(string calldata name) external view");
  });

  it("the ?? fixture compiles under solc", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-calldata-nullish-"));
    const file = path.join(dir, "CalldataNullish.sol");
    fs.writeFileSync(file, build("tests/contracts/CalldataNullish.ts"), "utf8");
    const r = compileSolidity({ solFiles: [file], config: ConfigSchema.parse({}) });
    expect(r.errors).toEqual([]);
  }, 60_000);

  it("keeps memory on a param passed to an own function that writes to it, through any number of hops", () => {
    // A calldata argument is copied into a memory parameter, so the caller would stop seeing the write.
    const s = build("tests/contracts/CalldataFlow.ts");
    expect(s).toContain("function bumpAndRead(uint256[] memory values) external");
    expect(s).toContain("function bumpViaHelper(uint256[] memory values) external");
    expect(s).toContain("function sumOf(uint256[] calldata values) external");
  });

  it("sees an own function called from a for-initializer as an internal call site", () => {
    const s = build("tests/contracts/CalldataFlow.ts");
    expect(s).toContain("function start(uint256[] memory values) public");
    expect(s).toContain("for (uint256 i = start(xs); i < 3; ) {");
  });

  it("the flow fixture compiles under solc", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-calldata-flow-"));
    const file = path.join(dir, "CalldataFlow.sol");
    fs.writeFileSync(file, build("tests/contracts/CalldataFlow.ts"), "utf8");
    const r = compileSolidity({ solFiles: [file], config: ConfigSchema.parse({}) });
    expect(r.errors).toEqual([]);
  }, 60_000);

  it("maps string .length to bytes(...).length", () => {
    expect(sol()).toContain("return bytes(s).length;");
  });

  it("the result compiles under solc", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-calldata-"));
    const file = path.join(dir, "Calldata.sol");
    fs.writeFileSync(file, sol(), "utf8");
    const r = compileSolidity({ solFiles: [file], config: ConfigSchema.parse({}) });
    expect(r.errors).toEqual([]);
  }, 60_000);
});

describe("build refuses to emit a program it would have to guess at", () => {
  const runBuild = (fixture: string) => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-build-"));
    const r = Bun.spawnSync({
      cmd: [process.execPath, "run", "src/cli/index.ts", "build", path.join(ROOT, fixture), "--out", out],
      cwd: ROOT,
    });
    return { code: r.exitCode, stderr: r.stderr.toString(), out };
  };

  it("exits non-zero and writes nothing when the validator reports errors", () => {
    const { code, stderr, out } = runBuild("tests/contracts/BadLowering.ts");
    expect(code).not.toBe(0);
    expect(stderr).toContain("nothing was written");
    expect(fs.readdirSync(out)).toEqual([]);
  }, 60_000);

  it("exits non-zero on parse errors too", () => {
    const { code, stderr } = runBuild("tests/contracts/BadBindings.ts");
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/rest element|nested destructuring/);
  }, 60_000);

  it("still builds a clean contract", () => {
    const { code, out } = runBuild("examples/counter/Counter.ts");
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(out, "Counter.sol"))).toBe(true);
  }, 60_000);
});

describe("unsupported binding forms are reported, not mangled", () => {
  it("flags defaults, rest elements and nested patterns", () => {
    const { diagnostics } = parseContractFiles([path.join(ROOT, "tests/contracts/BadBindings.ts")]);
    const messages = diagnostics.map((d) => d.message);
    expect(messages.some((m) => m.includes("default value for \"ok\""))).toBe(true);
    expect(messages.some((m) => m.includes("rest element"))).toBe(true);
    expect(messages.some((m) => m.includes("nested destructuring"))).toBe(true);
  });
});

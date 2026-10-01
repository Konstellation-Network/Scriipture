import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseContractFiles } from "../src/parser/parse";
import { emitProgram, sharedDefinitions } from "../src/emitter/emit";
import { generateFuzzHarness } from "../src/security/fuzz-gen";
import { proofStatus } from "../src/security/invariants";
import { parseDiagnosticsAsErrors } from "../src/validator/diagnostics";
import { compileSolidity } from "../src/compiler/solc";
import { ConfigSchema } from "../src/config/schema";

const ROOT = path.resolve(__dirname, "..");

function load(file: string) {
  const { program, diagnostics } = parseContractFiles([path.join(ROOT, file)]);
  return { contract: program.contracts[0]!, program, diagnostics };
}

// Enough of forge-std for the harness to compile without fetching it.
const TEST_STUB = `interface Vm { function assume(bool) external pure; }
contract Test { Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code"))))); }
`;

describe("fuzz harness with structs and enums", () => {
  const harness = () => generateFuzzHarness(load("tests/contracts/Registry.ts").contract)!;

  it("qualifies struct and enum names with the contract they belong to", () => {
    const s = harness().solidity;
    // Bare `Item` / `Status` are members of Registry and do not resolve inside the harness.
    expect(s).toContain("Registry.Item memory it");
    expect(s).toContain("Registry.Status s = Registry.Status(sRaw);");
    expect(s).not.toMatch(/\(Item memory|\(Status s/);
  });

  it("takes an enum as a bounded uint8, because the decoder rejects out-of-range values first", () => {
    const s = harness().solidity;
    expect(s).toContain("function testFuzz_SetStatus(uint8 sRaw) public {");
    expect(s).toContain("vm.assume(sRaw < 3);");
  });

  it("skips a method whose enum arrives inside an array, for the same reason", () => {
    const s = harness().solidity;
    expect(s).not.toContain("testFuzz_SetAll");
    expect(s).not.toContain("Status[]");
  });

  it("compiles under solc alongside the contract", () => {
    const { contract } = load("tests/contracts/Registry.ts");
    const { program } = parseContractFiles([path.join(ROOT, "tests/contracts/Registry.ts")]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-fuzz-"));
    fs.writeFileSync(path.join(dir, "Registry.sol"), emitProgram(program)[0]!.solidity, "utf8");
    const h = generateFuzzHarness(contract)!.solidity
      .replace('import "forge-std/Test.sol";', TEST_STUB)
      .replace('import "../src/Registry.sol";', 'import "./Registry.sol";');
    fs.writeFileSync(path.join(dir, "RegistryFuzzAuto.sol"), h, "utf8");
    const r = compileSolidity({
      solFiles: [path.join(dir, "Registry.sol"), path.join(dir, "RegistryFuzzAuto.sol")],
      config: ConfigSchema.parse({}),
    });
    expect(r.errors).toEqual([]);
    expect(r.artifacts.map((a) => a.contractName)).toContain("RegistryFuzzAuto");
  }, 60_000);

  it("emits no harness when nothing takes a parameter, instead of one forge reports as failing", () => {
    // Counter's methods all take zero arguments: `forge test --match-contract FuzzAuto`
    // would exit 1 with "No tests match", which reads as a gate failure.
    expect(generateFuzzHarness(load("examples/counter/Counter.ts").contract)).toBeNull();
  });
});

describe("a file-level interface is only a struct when it describes one", () => {
  it("keeps struct-shaped declarations and drops TypeScript-only ones", () => {
    const { contract, diagnostics } = load("tests/contracts/Registry.ts");
    expect(contract.structs.map((s) => s.name)).toEqual(["Item"]);
    expect(diagnostics).toEqual([]); // `Callbacks` is not an error, it is simply not a struct
    const sol = emitProgram(parseContractFiles([path.join(ROOT, "tests/contracts/Registry.ts")]).program)[0]!.solidity;
    expect(sol).toContain("struct Item {");
    expect(sol).not.toContain("struct Callbacks");
  });
});

describe("proof verdicts", () => {
  it("only calls a proof attempt passed when the solver settled something", () => {
    expect(proofStatus({ proven: ["a"], unproven: [], violated: [] })).toBe("passed");
    expect(proofStatus({ proven: ["a"], unproven: ["b"], violated: [] })).toBe("passed");
    expect(proofStatus({ proven: [], unproven: ["a", "b"], violated: [] })).toBe("skipped");
    expect(proofStatus({ proven: ["a"], unproven: [], violated: ["b"] })).toBe("failed");
  });

  it("does not let the auto-ERC20 tautology vouch for the contract's own invariants", () => {
    const spec = (name: string, origin: "decorator" | "auto-erc20") => ({ name, predicate: "", selfPredicate: "", origin });
    const auto = spec("supplyEqualsZero", "auto-erc20");
    // every declared invariant unproved; only `totalSupply() >= 0` came back proven
    expect(proofStatus({ proven: ["supplyEqualsZero"], unproven: ["solvent"], violated: [] }, [spec("solvent", "decorator"), auto])).toBe("skipped");
    // one declared invariant proven is a pass, whatever the tautology did
    expect(proofStatus({ proven: ["solvent", "supplyEqualsZero"], unproven: ["bounded"], violated: [] }, [spec("solvent", "decorator"), spec("bounded", "decorator"), auto])).toBe("passed");
    // a violation still fails regardless
    expect(proofStatus({ proven: ["supplyEqualsZero"], unproven: [], violated: ["solvent"] }, [spec("solvent", "decorator"), auto])).toBe("failed");
    // with nothing declared, the auto invariant is all there is, and its verdict stands as before
    expect(proofStatus({ proven: ["supplyEqualsZero"], unproven: [], violated: [] }, [auto])).toBe("passed");
  });
});

describe("parse diagnostics reach the gates", () => {
  it("become errors rather than being dropped", () => {
    const { diagnostics } = load("tests/contracts/BadTypes.ts");
    expect(diagnostics.length).toBeGreaterThan(0);
    const asErrors = parseDiagnosticsAsErrors(diagnostics);
    expect(asErrors.every((d) => d.severity === "error" && d.rule === "parse")).toBe(true);
    expect(asErrors.map((d) => d.message)).toEqual(diagnostics.map((d) => d.message));
  });
});

describe("fuzz harness for libraries, overloads and shared types", () => {
  const { program } = parseContractFiles([path.join(ROOT, "tests/contracts/Advanced.ts")]);
  const shared = sharedDefinitions(program).values().next().value!.typeNames;
  const contract = (name: string) => program.contracts.find((c) => c.name === name)!;

  it("has no harness for a library, which is never deployed on its own", () => {
    expect(generateFuzzHarness(contract("MathLib"), shared)).toBeNull();
  });

  it("gives each overload its own test, and leaves file-level types unqualified", () => {
    const s = generateFuzzHarness(contract("Advanced"), shared)!.solidity;
    expect(s).toContain("function testFuzz_Put(uint256 a) public {");
    expect(s).toContain("function testFuzz_Put_2(uint256 a, uint256 b) public {");
    expect(s).toContain("Point memory p");
    expect(s).not.toContain("Advanced.Point");
    // A function pointer parameter is not fuzzable.
    expect(s).not.toContain("testFuzz_ApplyTwice");
  });

  it("compiles under solc alongside the contracts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-fuzz-adv-"));
    const files = emitProgram(program).map((e) => {
      const f = path.join(dir, `${e.name}.sol`);
      fs.writeFileSync(f, e.solidity, "utf8");
      return f;
    });
    const h = generateFuzzHarness(contract("Advanced"), shared)!.solidity
      .replace('import "forge-std/Test.sol";', TEST_STUB)
      .replace('import "../src/Advanced.sol";', 'import "./Advanced.sol";');
    fs.writeFileSync(path.join(dir, "AdvancedFuzzAuto.sol"), h, "utf8");
    const r = compileSolidity({ solFiles: [...files, path.join(dir, "AdvancedFuzzAuto.sol")], config: ConfigSchema.parse({}) });
    expect(r.errors).toEqual([]);
    expect(r.artifacts.map((a) => a.contractName)).toContain("AdvancedFuzzAuto");
  }, 60_000);
});

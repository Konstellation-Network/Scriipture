import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseContractFiles } from "../src/parser/parse";
import { emitProgram } from "../src/emitter/emit";
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

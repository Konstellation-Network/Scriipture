import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { parseContractFiles } from "../src/parser/parse";
import { emitProgram } from "../src/emitter/emit";
import { optimizeProgram } from "../src/optimizer/passes";
import { validateProgram } from "../src/validator/rules";
import { compileSolidity } from "../src/compiler/solc";
import { ConfigSchema } from "../src/config/schema";
import { PARITY_CASES } from "./solidity-parity.cases";

const ROOT = path.resolve(__dirname, "..");
const PARITY = path.join(ROOT, "tests/contracts/Parity.ts");

/** What `scriipture build` does, then solc: every diagnostic along the way, and the emitted files. */
function build(files: string[], opts: { secure?: boolean } = {}) {
  const { program, diagnostics } = parseContractFiles(files);
  const errors = validateProgram(program, { secure: opts.secure }).filter((d) => d.severity === "error");
  optimizeProgram(program);
  const emitted = emitProgram(program);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-parity-"));
  const solFiles = emitted.map((e) => {
    const f = path.join(dir, `${e.name}.sol`);
    fs.writeFileSync(f, e.solidity, "utf8");
    return f;
  });
  const compiled = compileSolidity({ solFiles, config: ConfigSchema.parse({}) });
  return {
    program,
    parse: diagnostics.map((d) => d.message),
    validate: errors.map((d) => `${d.rule}: ${d.message}`),
    solc: compiled.errors,
    artifacts: compiled.artifacts.map((a) => a.contractName),
    emitted,
    sol: emitted.map((e) => e.solidity).join("\n"),
    dir,
  };
}

function buildSource(src: string, name = "C") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-parity-src-"));
  const file = path.join(dir, `${name}.ts`);
  fs.writeFileSync(file, src, "utf8");
  return build([file]);
}

describe("each Solidity feature has a TypeScript spelling that emits it", () => {
  for (const c of PARITY_CASES) {
    it(`${c.id}: ${c.feature}`, () => {
      const r = buildSource(c.src);
      expect({ parse: r.parse, validate: r.validate, solc: r.solc }).toEqual({ parse: [], validate: [], solc: [] });
      for (const re of c.expect ?? []) expect(r.sol).toMatch(re);
    }, 30_000);
  }
});

describe("what cannot be lowered is reported, not dropped", () => {
  const diagnostics = (src: string) => {
    const r = buildSource(src);
    return [...r.parse, ...r.validate];
  };

  it("an unknown decorator on a function -- a misspelled modifier used to ship the function unguarded", () => {
    const d = diagnostics(`
export class C {
  @modifier onlyAdmin(): void { require(msg.sender === this.admin); }
  @onlyAdmn doit(): void {}
  @storage admin: Address;
}`);
    expect(d.some((m) => m.startsWith("unknown-decorator") && m.includes("@onlyAdmn"))).toBe(true);
  });

  it("param() naming something that is not a parameter of the decorated function", () => {
    const d = diagnostics(`
export class C { @storage n: bigint = 0n;
  @modifier m(x: bigint): void { require(x > 0n); }
  @m(param("idd")) f(id: bigint): void { this.n = id; } }`);
    expect(d.some((m) => m.includes('param("idd")') && m.includes("not one of its parameters"))).toBe(true);
  });

  it("an unknown decorator on a state variable", () => {
    expect(diagnostics(`export class C { @storage @external x: bigint = 0n; }`).some((m) => m.includes("@external on state variable"))).toBe(true);
  });

  it("JavaScript's standard library", () => {
    expect(diagnostics(`export class C { @pure f(a: bigint, b: bigint): bigint { return Math.max(a, b); } }`).some((m) => m.includes("Math.max"))).toBe(true);
  });

  it("throwing something that is neither an Error nor a declared error", () => {
    expect(diagnostics(`export class C { f(a: bigint): void { throw a; } }`).some((m) => m.includes("`throw` needs"))).toBe(true);
  });

  it("a try block whose first statement is not an external call, and finally", () => {
    const d = diagnostics(`
export class C {
  @storage n: bigint = 0n;
  f(): void { try { this.n = 1n; } catch { this.n = 2n; } }
  g(t: Address): void { try { at<IX>(t).go(); } catch { this.n = 2n; } finally { this.n = 3n; } }
}
interface IX { go(): void; }`);
    expect(d.some((m) => m.includes("first statement of a `try` block"))).toBe(true);
    expect(d.some((m) => m.includes("`finally`"))).toBe(true);
  });

  it("receive() with parameters", () => {
    expect(diagnostics(`export class C { @payable receive(x: bigint): void {} }`).some((m) => m.includes("takes no parameters"))).toBe(true);
  });

  it("implementing an interface that is not in the build", () => {
    expect(diagnostics(`export class C implements INowhere { @storage n: bigint = 0n; }`).some((m) => m.includes("INowhere"))).toBe(true);
  });
});

describe("tests/contracts/Parity.ts: the features together, in one realistic build", () => {
  const r = build([PARITY], { secure: true });
  const file = (name: string) => r.emitted.find((e) => e.name === name)!.solidity;

  it("parses, passes the secure-mode validator, and compiles every contract and interface", () => {
    expect({ parse: r.parse, validate: r.validate, solc: r.solc }).toEqual({ parse: [], validate: [], solc: [] });
    expect(r.artifacts.sort()).toEqual(["IERC20", "IPriced", "Vault", "VaultBase", "VaultFactory"]);
  }, 60_000);

  it("emits interfaces to their own files, with JSDoc mutability", () => {
    expect(file("IERC20")).toContain("interface IERC20 {");
    expect(file("IERC20")).toContain("function balanceOf(address owner) external view returns (uint256);");
    expect(file("IERC20")).toContain("function transfer(address to, uint256 amount) external returns (bool);");
    expect(file("Vault")).toContain('import "./IERC20.sol";');
  });

  it("abstract base, implements, virtual and override", () => {
    expect(file("VaultBase")).toContain("abstract contract VaultBase is IPriced {");
    expect(file("VaultBase")).toContain("function fee(uint256 amount) public view virtual returns (uint256);");
    expect(file("Vault")).toContain("function fee(uint256 amount) public view override returns (uint256) {");
  });

  it("an enum shared by a base and its derived contract is declared once, in the base", () => {
    expect(file("VaultBase")).toContain("enum Phase { Open, Closed }");
    expect(file("Vault")).not.toContain("enum Phase");
  });

  it("modifiers, receive, try / catch, tuples, units and conversions", () => {
    const vault = file("Vault");
    expect(file("VaultBase")).toMatch(/modifier notBefore\(uint256 t\) \{[\s\S]*?_;\n    \}/);
    expect(vault).toContain("function sweep(address token) public onlyKeeper notBefore(7 days) returns (uint256) {");
    expect(vault).toContain("receive() external payable {");
    expect(vault).toContain("try IERC20(token).balanceOf(address(this)) returns (uint256 bal) {");
    expect(vault).toContain("bool ok = IERC20(token).transfer(keeper, bal);");
    expect(vault).toContain("} catch {");
    expect(vault).toContain("(uint256 net, uint256 f) = split(total);");
    expect(vault).toContain("return (amount - f, f);");
    expect(vault).toContain("revert TooSmall(msg.value, 1 ether / 1000);");
    expect(vault).toContain("return uint64(x);");
    expect(vault).toContain("} while (steps < uint256(n));");
    expect(vault).toContain("(address to, uint256 amount) = abi.decode(data, (address, uint256));");
    expect(vault).toContain("return 0xa9059cbb;");
    expect(vault).toContain("bytes32 h = keccak256(abi.encode(salt, total));");
    expect(file("VaultFactory")).toContain("Vault v = new Vault();");
  });

  it("type-checks against the published typings (types/index.d.ts)", () => {
    const program = ts.createProgram([PARITY, path.join(ROOT, "types/index.d.ts")], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      experimentalDecorators: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
      baseUrl: ROOT,
      paths: { scriipture: ["./types/index.d.ts"] },
    });
    const diags = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(diags).toEqual([]);
  }, 60_000);

  const forge = spawnSync("forge", ["--version"], { encoding: "utf8" });
  it.skipIf(forge.status !== 0)("behaves as written on the EVM (forge, when installed)", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-parity-forge-"));
    fs.mkdirSync(path.join(project, "src"));
    fs.mkdirSync(path.join(project, "test"));
    for (const e of r.emitted) fs.writeFileSync(path.join(project, "src", `${e.name}.sol`), e.solidity, "utf8");
    fs.copyFileSync(path.join(ROOT, "tests/contracts/Parity.behavior.t.sol"), path.join(project, "test", "Parity.t.sol"));
    fs.writeFileSync(path.join(project, "foundry.toml"), '[profile.default]\nsrc = "src"\ntest = "test"\nout = "out"\nlibs = []\noffline = true\n', "utf8");
    const run = spawnSync("forge", ["test", "--root", project], { encoding: "utf8" });
    expect(run.stdout + run.stderr).toContain("0 failed");
    expect(run.status).toBe(0);
  }, 180_000);
});

describe("regressions found while aligning with Solidity", () => {
  it("a method-only interface nothing uses is a TS-only shape and is not emitted", () => {
    const r = build([path.join(ROOT, "tests/contracts/Registry.ts")]);
    expect(r.emitted.map((e) => e.name)).toEqual(["Registry"]);
  });

  it("JSDoc tags solc does not know become valid NatSpec instead of a DocstringParsingError", () => {
    const r = buildSource(`
export class C {
  @storage n: bigint = 0n;
  /**
   * Doubles.
   * @param x the input
   * @returns twice x
   * @throws never
   */
  @pure twice(x: bigint): bigint { return x * 2n; }
}`);
    expect(r.solc).toEqual([]);
    expect(r.sol).toContain("/// @return twice x");
    expect(r.sol).toContain("/// @custom:throws never");
  }, 30_000);

  it("a derived contract reuses the error custom-errors synthesized in its base instead of redeclaring it", () => {
    const r = buildSource(`
export class Base { @storage owner: Address; f(): void { require(msg.sender === this.owner, "not owner"); } }
export class Child extends Base { g(): void { require(msg.sender === this.owner, "not owner"); } }`);
    expect(r.solc).toEqual([]);
    const child = r.emitted.find((e) => e.name === "Child")!.solidity;
    expect(child).not.toContain("error NotOwner");
    expect(child).toContain("revert NotOwner();");
  }, 30_000);

  it("an event declared in a base can be emitted from the derived contract", () => {
    const r = buildSource(`
export class Base { @event Ping(v: bigint): void {} }
export class Child extends Base { @storage n: bigint = 0n; go(): void { this.n += 1n; emit(this.Ping(this.n)); } }`);
    expect(r.validate).toEqual([]);
    expect(r.solc).toEqual([]);
  }, 30_000);

  it("the optimizer does not freeze a base's variable that only a derived contract writes", () => {
    const r = buildSource(`
export class Base { @storage limit: bigint = 10n; @storage owner: Address; constructor() { this.owner = msg.sender; } }
export class Child extends Base { raise(): void { this.limit = 20n; this.owner = msg.sender; } }`);
    expect(r.solc).toEqual([]);
    const base = r.emitted.find((e) => e.name === "Base")!.solidity;
    expect(base).toContain("uint256 public limit = 10;");
    expect(base).toContain("address public owner;");
  }, 30_000);
});

describe("the README's second example is what build really emits", () => {
  it("examples/tips/Tips.ts → the Solidity blocks in README.md", () => {
    const r = build([path.join(ROOT, "examples/tips/Tips.ts")]);
    expect({ parse: r.parse, validate: r.validate, solc: r.solc }).toEqual({ parse: [], validate: [], solc: [] });
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    const tips = r.emitted.find((e) => e.name === "Tips")!.solidity.trim();
    const iface = r.emitted.find((e) => e.name === "IERC20")!.solidity;
    expect(readme).toContain(tips);
    expect(readme).toContain(iface.slice(iface.indexOf("interface")).trim());
  }, 60_000);
});

describe("examples/crowdfund: a full sample contract", () => {
  const FILE = path.join(ROOT, "examples/crowdfund/Crowdfund.ts");
  const r = build([FILE], { secure: true });

  it("passes the secure-mode validator and compiles", () => {
    expect({ parse: r.parse, validate: r.validate, solc: r.solc }).toEqual({ parse: [], validate: [], solc: [] });
  }, 60_000);

  it("type-checks against the published typings", () => {
    const program = ts.createProgram([FILE, path.join(ROOT, "types/index.d.ts")], {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true, experimentalDecorators: true, noEmit: true, skipLibCheck: true, types: [],
      baseUrl: ROOT, paths: { scriipture: ["./types/index.d.ts"] },
    });
    expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  }, 60_000);

  const forge = spawnSync("forge", ["--version"], { encoding: "utf8" });
  it.skipIf(forge.status !== 0)("launch, pledge, claim, refund, deadlines and events behave on the EVM (forge, when installed)", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-crowdfund-forge-"));
    fs.mkdirSync(path.join(project, "src"));
    fs.mkdirSync(path.join(project, "test"));
    for (const e of r.emitted) fs.writeFileSync(path.join(project, "src", `${e.name}.sol`), e.solidity, "utf8");
    fs.copyFileSync(path.join(ROOT, "tests/contracts/Crowdfund.behavior.t.sol"), path.join(project, "test", "Crowdfund.t.sol"));
    const oz = path.join(ROOT, "node_modules/@openzeppelin");
    fs.writeFileSync(
      path.join(project, "foundry.toml"),
      `[profile.default]\nsrc = "src"\ntest = "test"\nout = "out"\nlibs = []\noffline = true\nremappings = ["@openzeppelin/=${oz}/"]\nallow_paths = ["${oz}"]\n`,
      "utf8",
    );
    const run = spawnSync("forge", ["test", "--root", project], { encoding: "utf8" });
    expect(run.stdout + run.stderr).toContain("6 passed; 0 failed");
    expect(run.status).toBe(0);
  }, 180_000);
});

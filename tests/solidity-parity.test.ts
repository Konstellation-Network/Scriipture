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

describe("tests/contracts/Advanced.ts: libraries, free functions, value types and the rest", () => {
  const FILE = path.join(ROOT, "tests/contracts/Advanced.ts");
  const r = build([FILE], { secure: true });
  const file = (name: string) => r.emitted.find((e) => e.name === name)!.solidity;

  it("parses, passes the secure-mode validator, and compiles", () => {
    expect({ parse: r.parse, validate: r.validate, solc: r.solc }).toEqual({ parse: [], validate: [], solc: [] });
    expect(r.artifacts.sort()).toEqual(["Advanced", "Broken", "IMeasure", "MathLib", "Measurer"]);
    expect(r.emitted.map((e) => [e.name, e.kind])).toContainEqual(["Advanced.defs", "defs"]);
  }, 60_000);

  it("a @library class is a library of internal functions, attached with using … for", () => {
    expect(file("MathLib")).toContain("library MathLib {");
    expect(file("MathLib")).toContain("uint256 public constant ONE = 1;");
    expect(file("MathLib")).toContain("function max(uint256 a, uint256 b) internal pure returns (uint256) {");
    expect(file("Advanced")).toContain("using MathLib for *;");
    expect(file("Advanced")).toContain("put(MathLib.max(a, b));");
    expect(file("Advanced")).toContain('import "./MathLib.sol";');
  });

  it("free functions, file-level constants, and the types they and the interface share go to the .defs file", () => {
    const defs = file("Advanced.defs");
    expect(defs).toContain("type Price is uint128;");
    expect(defs).toContain("struct Point {");
    expect(defs).toContain("uint256 constant MAX_AMOUNT = 1000000;");
    expect(defs).toContain('bytes32 constant TAG = keccak256("advanced");');
    expect(defs).toContain("function clamp(uint256 v, uint256 hi) pure returns (uint256) {");
    expect(defs).toContain("function origin() pure returns (Point memory) {");
    for (const name of ["Advanced", "Measurer", "MathLib", "IMeasure"]) {
      expect(file(name)).toContain('import "./Advanced.defs.sol";');
      expect(file(name)).not.toContain("struct Point");
    }
    expect(file("IMeasure")).toContain("function area(Point calldata p) external view returns (uint256);");
  });

  it("overloads, named returns, value types, function types, CREATE2, typed catches, anonymous events, transient", () => {
    const a = file("Advanced");
    expect(a).toContain("function put(uint256 a) public {");
    expect(a).toContain("function put(uint256 a, uint256 b) public {");
    expect(a).toContain("function split() public view returns (uint256 half, bool odd) {");
    expect(a).toContain("half = total / 2;");
    expect(a).toContain("last = Price.wrap(p);");
    expect(a).toContain("return Price.unwrap(last);");
    expect(a).toContain("function applyTwice(function (uint256) internal pure returns (uint256) f, uint256 x) private pure returns (uint256) {");
    expect(a).toContain("return applyTwice(triple, x);");
    expect(a).toContain("Measurer m = new Measurer{salt: salt, value: msg.value}(side);");
    expect(a).toMatch(/\} catch Error\(string memory\) \{[\s\S]*\} catch Panic\(uint256 code\) \{[\s\S]*\} catch \{/);
    expect(a).toContain("event Moved(address indexed from, address indexed to, uint256 indexed amount, bytes32 indexed tag) anonymous;");
    expect(a).toContain("bool public transient entered;");
    expect(a).toContain("pragma solidity ^0.8.28;");
    expect(file("Measurer")).toContain("constructor(uint256 side_) payable {");
    expect(file("Measurer")).toContain("side = side_;");
  });

  it("type-checks against the published typings", () => {
    const program = ts.createProgram([FILE, path.join(ROOT, "types/index.d.ts")], {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true, experimentalDecorators: true, noEmit: true, skipLibCheck: true, types: [],
      baseUrl: ROOT, paths: { scriipture: ["./types/index.d.ts"] },
    });
    expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  }, 60_000);

  const forge = spawnSync("forge", ["--version"], { encoding: "utf8" });
  it.skipIf(forge.status !== 0)("behaves as written on the EVM (forge, when installed)", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-advanced-forge-"));
    fs.mkdirSync(path.join(project, "src"));
    fs.mkdirSync(path.join(project, "test"));
    for (const e of r.emitted) fs.writeFileSync(path.join(project, "src", `${e.name}.sol`), e.solidity, "utf8");
    fs.copyFileSync(path.join(ROOT, "tests/contracts/Advanced.behavior.t.sol"), path.join(project, "test", "Advanced.t.sol"));
    fs.writeFileSync(path.join(project, "foundry.toml"), '[profile.default]\nsrc = "src"\ntest = "test"\nout = "out"\nlibs = []\noffline = true\n', "utf8");
    const run = spawnSync("forge", ["test", "--root", project], { encoding: "utf8" });
    expect(run.stdout + run.stderr).toContain("8 passed; 0 failed");
    expect(run.status).toBe(0);
  }, 180_000);
});

describe("misuse of the advanced spellings is reported, not miscompiled", () => {
  const diagnostics = (src: string) => {
    const r = buildSource(src);
    return [...r.parse, ...r.validate];
  };
  const has = (d: string[], s: string) => expect(d.some((m) => m.includes(s))).toBe(true);

  it("a library with state, a non-static method, a base or a constructor", () => {
    const d = diagnostics(`
@library export class L extends Base { count: bigint = 0n; constructor() {} f(): bigint { return 1n; } }
export class Base { @storage n: bigint = 0n; }`);
    has(d, "cannot extend or implement");
    has(d, "cannot hold state");
    has(d, "must be `static`");
    has(d, "cannot have a constructor");
  });

  it("an unknown class decorator, and @using without a library", () => {
    has(diagnostics(`@sealed export class C { @storage n: bigint = 0n; }`), "@sealed on class C");
    has(diagnostics(`@using export class C { @storage n: bigint = 0n; }`), "`@using` takes one library class");
  });

  it("a value type whose brand does not match, or over a non-value type", () => {
    has(diagnostics(`type Price = ValueType<Uint128, "Cost">; export class C { @storage p: Price; }`), 'must be the type\'s own name, "Price"');
    has(diagnostics(`type Name = ValueType<string, "Name">; export class C { @storage p: Name; }`), "wraps an elementary value type");
  });

  it("wrap without its type, and unwrap of something that is not a value type", () => {
    has(diagnostics(`type Price = ValueType<Uint128, "Price">; export class C { @storage p: Price; f(x: Uint128): void { this.p = wrap(x); } }`), "`wrap` needs the value type");
    has(diagnostics(`export class C { @pure f(x: bigint): bigint { return unwrap(x); } }`), "value-type-unwrap");
  });

  it("a file-level let, and a file-level constant without a value", () => {
    has(diagnostics(`let counter = 0n; export class C { @storage n: bigint = 0n; }`), 'file-level "counter" is not `const`');
  });

  it("create with an option other than salt and value, or without a contract", () => {
    has(diagnostics(`export class K {} export class C { f(): void { create(K, { gas: 5n }); } }`), "`salt` and `value` only");
    has(diagnostics(`export class C { f(): void { create({ salt: 1n }); } }`), "`create` takes a contract class");
  });

  it("@overload without a usable name, and a transient variable with an initializer", () => {
    has(diagnostics(`export class C { @storage n: bigint = 0n; @overload(5n) f(): void { this.n = 1n; } }`), "`@overload` takes the Solidity name");
    has(diagnostics(`export class C { @transient @storage n: bigint = 1n; }`), "cannot have an initializer");
  });

  it("an anonymous event allows four indexed parameters, not five", () => {
    expect(diagnostics(`export class C { @event({ anonymous: true }) E(a: Indexed<bigint>, b: Indexed<bigint>, c: Indexed<bigint>, d: Indexed<bigint>): void {} }`)).toEqual([]);
    has(diagnostics(`export class C { @event({ anonymous: true }) E(a: Indexed<bigint>, b: Indexed<bigint>, c: Indexed<bigint>, d: Indexed<bigint>, e: Indexed<bigint>): void {} }`), "at most 4 on an anonymous event");
    has(diagnostics(`export class C { @event({ indexed: true }) E(a: bigint): void {} }`), "`{ anonymous: true }`");
  });

  it("free functions are validated like methods", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-free-"));
    const f = path.join(dir, "C.ts");
    fs.writeFileSync(f, `export function who(): Address { return tx.origin; } export class C { @storage n: bigint = 0n; }`, "utf8");
    has(build([f], { secure: true }).validate, "no-tx-origin");
  });
});

describe("a parameter or local named like a state variable no longer writes to itself", () => {
  it("constructor(owner) { this.owner = owner } sets the state variable", () => {
    const r = buildSource(`
export class C {
  @storage owner: Address; @storage limit: bigint = 0n;
  constructor(owner: Address) { this.owner = owner; }
  setLimit(limit: bigint): void { const owner = msg.sender; require(owner === this.owner, "no"); this.limit = limit; }
}`);
    expect(r.solc).toEqual([]);
    expect(r.sol).toContain("constructor(address owner_) {");
    expect(r.sol).toContain("owner = owner_;");
    expect(r.sol).toContain("function setLimit(uint256 limit_) public {");
    expect(r.sol).toContain("address owner_ = msg.sender;");
    expect(r.sol).toContain("limit = limit_;");
  }, 30_000);
});

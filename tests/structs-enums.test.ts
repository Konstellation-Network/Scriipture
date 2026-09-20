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
const FIXTURE = path.join(ROOT, "tests/contracts/Governance.ts");

describe("structs, enums and fixed-width integers", () => {
  it("parses file-level enum and interface declarations into the IR", () => {
    const { program, diagnostics } = parseContractFiles([FIXTURE]);
    expect(diagnostics).toEqual([]);
    const c = program.contracts[0]!;
    expect(c.enums).toEqual([expect.objectContaining({ name: "Status", members: ["Pending", "Active", "Executed"] })]);
    expect(c.structs).toHaveLength(1);
    expect(c.structs[0]!.name).toBe("Proposal");
    expect(c.structs[0]!.fields.map((f) => [f.name, f.type])).toEqual([
      ["id", { kind: "primitive", name: "uint256" }],
      ["proposer", { kind: "primitive", name: "address" }],
      ["votes", { kind: "primitive", name: "uint64" }],
      ["status", { kind: "enum", name: "Status" }],
    ]);
  });

  it("maps Uint8/Uint64 annotations to narrow primitives and struct/enum names to their kinds", () => {
    const { program } = parseContractFiles([FIXTURE]);
    const c = program.contracts[0]!;
    const type = (n: string) => c.stateVars.find((v) => v.name === n)!.type;
    expect(type("quorum")).toEqual({ kind: "primitive", name: "uint8" });
    expect(type("proposalCount")).toEqual({ kind: "primitive", name: "uint64" });
    expect(type("proposals")).toEqual({ kind: "mapping", key: { kind: "primitive", name: "uint256" }, value: { kind: "struct", name: "Proposal" } });
    expect(type("current")).toEqual({ kind: "enum", name: "Status" });
  });

  it("emits enum and struct declarations with narrow field types", () => {
    const { program } = parseContractFiles([FIXTURE]);
    const sol = emitProgram(program)[0]!.solidity;
    expect(sol).toContain("    enum Status { Pending, Active, Executed }");
    expect(sol).toContain("    struct Proposal {\n        uint256 id;\n        address proposer;\n        uint64 votes;\n        Status status;\n    }");
    expect(sol).toContain("uint8 public quorum = 51;");
    expect(sol).toContain("uint64 public proposalCount = 0;");
    expect(sol).toContain("mapping(uint256 => Proposal) public proposals;");
    expect(sol).toContain("Status public current = Status.Pending;");
  });

  it("lowers object literals to named struct constructors", () => {
    const { program } = parseContractFiles([FIXTURE]);
    const sol = emitProgram(program)[0]!.solidity;
    // from the mapping value type
    expect(sol).toContain("proposals[id] = Proposal({id: id, proposer: msg.sender, votes: 0, status: Status.Pending});");
    // from the function return type
    expect(sol).toContain("return Proposal({id: id, proposer: proposer, votes: 0, status: Status.Pending});");
    expect(sol).toContain("returns (Proposal memory)");
  });

  it("binds struct locals read from storage as storage references", () => {
    const { program } = parseContractFiles([FIXTURE]);
    const sol = emitProgram(program)[0]!.solidity;
    expect(sol).toContain("Proposal storage p = proposals[id];");
    expect(sol).toContain("p.votes = (p.votes + 1);");
    expect(sol).toContain("proposals[id].status = Status.Active;");
  });

  it("the emitted contract compiles with solc after optimization", () => {
    const { program } = parseContractFiles([FIXTURE]);
    optimizeProgram(program);
    const sol = emitProgram(program)[0]!.solidity;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-structs-"));
    const file = path.join(dir, "Governance.sol");
    fs.writeFileSync(file, sol, "utf8");
    const result = compileSolidity({ solFiles: [file], config: ConfigSchema.parse({}) });
    expect(result.errors).toEqual([]);
    expect(result.artifacts.map((a) => a.contractName)).toContain("Governance");
  }, 60_000);

  it("pack-slots sees narrow ints and enums as packable", () => {
    const { program } = parseContractFiles([FIXTURE]);
    const [report] = optimizeProgram(program);
    const hint = report!.changes.find((c) => c.pass === "pack-slots")!;
    // proposalCount (64 bits) and current (enum, 8 bits) are split by the mapping today.
    expect(hint.detail).toContain("2 storage slot(s) (currently 3)");
  });

  it("reports enum initializers, bad widths and untyped object literals", () => {
    const { diagnostics } = parseContractFiles([path.join(ROOT, "tests/contracts/BadTypes.ts")]);
    const messages = diagnostics.map((d) => d.message);
    expect(messages.some((m) => m.includes("Level.Low") && m.includes("remove the initializer"))).toBe(true);
    expect(messages.some((m) => m.includes("Uint7"))).toBe(true);
    expect(messages.some((m) => m.includes("object literal has no struct type"))).toBe(true);
  });
});

describe("declarations referenced before they are declared", () => {
  const FORWARD = path.join(ROOT, "tests/contracts/ForwardRefs.ts");

  it("resolves struct fields whose struct or enum is declared later in the file", () => {
    const { program, diagnostics } = parseContractFiles([FORWARD]);
    expect(diagnostics).toEqual([]);
    const proposal = program.contracts[0]!.structs.find((s) => s.name === "Proposal")!;
    expect(proposal.fields.map((f) => [f.name, f.type])).toEqual([
      ["id", { kind: "primitive", name: "uint256" }],
      ["meta", { kind: "struct", name: "Meta" }],
      ["status", { kind: "enum", name: "Status" }],
    ]);
  });

  it("types nested literals through a forward-referenced field, and under a cast literal in an untyped local", () => {
    const { program } = parseContractFiles([FORWARD]);
    const sol = emitProgram(program)[0]!.solidity;
    // via the mapping value type, one struct deep
    expect(sol).toContain("proposals[id] = Proposal({id: id, meta: Meta({title: title, votes: 0}), status: Status.Pending});");
    // via `as Proposal` alone -- the local it initialises has no annotation
    expect(sol).toContain("Proposal memory p = Proposal({id: id, meta: Meta({title: title, votes: 0}), status: Status.Pending});");
  });

  it("types an untyped local from an own method that returns a struct", () => {
    const { program } = parseContractFiles([FORWARD]);
    const sol = emitProgram(program)[0]!.solidity;
    expect(sol).toContain("Proposal memory p = draft(id, \"copy\");");
    expect(sol).not.toContain("uint256 p =");
  });

  it("the emitted contract compiles with solc", () => {
    const { program } = parseContractFiles([FORWARD]);
    optimizeProgram(program);
    const sol = emitProgram(program)[0]!.solidity;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-forward-"));
    const file = path.join(dir, "Forward.sol");
    fs.writeFileSync(file, sol, "utf8");
    const result = compileSolidity({ solFiles: [file], config: ConfigSchema.parse({}) });
    expect(result.errors).toEqual([]);
    expect(result.artifacts.map((a) => a.contractName)).toContain("Forward");
  }, 60_000);

  it("still leaves a method-only interface unregistered when another struct names it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-forward-"));
    const file = path.join(dir, "Hooks.ts");
    fs.writeFileSync(file, [
      `import { storage } from "scriipture";`,
      `export interface Job { id: bigint; hooks: Hooks }`,
      `export interface Hooks { onDone(): void }`,
      `export class Jobs { @storage next: bigint = 0n; }`,
    ].join("\n"), "utf8");
    const { program, diagnostics } = parseContractFiles([file]);
    expect(diagnostics).toEqual([]);
    const c = program.contracts[0]!;
    expect(c.structs.map((s) => s.name)).toEqual(["Job"]);
    expect(c.structs[0]!.fields[1]!.type).toEqual({ kind: "custom", name: "Hooks" });
  });
});

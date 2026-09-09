import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseContractFiles } from "../src/parser/parse";
import { emitProgram } from "../src/emitter/emit";
import { validateProgram } from "../src/validator/rules";
import { optimizeProgram } from "../src/optimizer/passes";

function parse(src: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-errors-"));
  const file = path.join(dir, "E.ts");
  fs.writeFileSync(file, src, "utf8");
  const { program } = parseContractFiles([file]);
  fs.rmSync(dir, { recursive: true, force: true });
  return program;
}

const WITHDRAW = `
@contract
export class Errors {
  balance: bigint = 0n;

  @error InsufficientBalance(available: bigint, required: bigint): void {}

  @external
  withdraw(amount: bigint): void {
    if (amount > this.balance) {
      revert(InsufficientBalance(this.balance, amount));
    }
    this.balance = this.balance - amount;
  }
}
`;

describe("custom errors", () => {
  it("parses @error declarations with typed parameters", () => {
    const c = parse(WITHDRAW).contracts[0]!;
    expect(c.errors.length).toBe(1);
    expect(c.errors[0]!.name).toBe("InsufficientBalance");
    expect(c.errors[0]!.params.map((p) => p.name)).toEqual(["available", "required"]);
    expect(c.errors[0]!.params[0]!.type).toEqual({ kind: "primitive", name: "uint256" });
  });

  it("does not treat an @error member as a function", () => {
    expect(parse(WITHDRAW).contracts[0]!.functions.map((f) => f.name)).toEqual(["withdraw"]);
  });

  it("emits the declaration and the revert Name(args) form", () => {
    const sol = emitProgram(parse(WITHDRAW))[0]!.solidity;
    expect(sol).toContain("error InsufficientBalance(uint256 available, uint256 required);");
    expect(sol).toContain("revert InsufficientBalance(balance, amount);");
    // the string-revert form would be wrong here
    expect(sol).not.toContain("revert(InsufficientBalance");
  });

  it("emits no data location on error parameters", () => {
    const sol = emitProgram(parse(`
@contract
export class E {
  @error Bad(reason: string): void {}
  @external
  go(): void { revert(Bad("x")); }
}
`))[0]!.solidity;
    expect(sol).toContain("error Bad(string reason);");
    expect(sol).not.toContain("string memory reason");
  });

  it("leaves revert(\"string\") as a string revert", () => {
    const sol = emitProgram(parse(`
@contract
export class E {
  @external
  go(): void { revert("plain string revert"); }
}
`))[0]!.solidity;
    expect(sol).toContain('revert("plain string revert");');
  });

  it("does not let the custom-errors pass collide with a declared error", () => {
    const program = parse(`
@contract
export class E {
  balance: bigint = 0n;

  @error InsufficientBalance(available: bigint, required: bigint): void {}

  @external
  b(amount: bigint): void {
    require(amount <= this.balance, "insufficient balance");
    this.balance = this.balance - amount;
  }
}
`);
    optimizeProgram(program);
    const names = program.contracts[0]!.errors.map((e) => e.name);
    expect(names).toEqual(["InsufficientBalance"]);
    const sol = emitProgram(program)[0]!.solidity;
    // the require keeps its string form rather than emitting a duplicate error
    expect(sol).toContain("error InsufficientBalance(uint256 available, uint256 required);");
    expect((sol.match(/error InsufficientBalance/g) ?? []).length).toBe(1);
  });

  it("rejects revert of an undeclared error", () => {
    const d = validateProgram(parse(`
@contract
export class E {
  @external
  go(): void { revert(NeverDeclared(1n)); }
}
`)).find((x) => x.rule === "undeclared-error");
    expect(d).toBeDefined();
    expect(d!.message).toContain("NeverDeclared");
    expect(d!.loc?.file.endsWith(".ts")).toBe(true);
  });

  it("accepts a declared error", () => {
    expect(validateProgram(parse(WITHDRAW)).filter((d) => d.rule === "undeclared-error")).toEqual([]);
  });
});

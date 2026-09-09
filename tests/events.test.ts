import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseContractFiles } from "../src/parser/parse";
import { emitProgram } from "../src/emitter/emit";
import { validateProgram } from "../src/validator/rules";
import { optimizeProgram } from "../src/optimizer/passes";

function parse(src: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-events-"));
  const file = path.join(dir, "E.ts");
  fs.writeFileSync(file, src, "utf8");
  const { program } = parseContractFiles([file]);
  fs.rmSync(dir, { recursive: true, force: true });
  return program;
}

const PAYMENTS = `
@contract
export class Payments {
  total: bigint = 0n;

  @event Paid(
    from: Indexed<Address>,
    to: Indexed<Address>,
    amount: bigint,
    memo: string
  ): void {}

  @external
  pay(to: Address, amount: bigint): void {
    this.total = this.total + amount;
    emit(Paid(msg.sender, to, amount, "thanks"));
  }
}
`;

describe("events", () => {
  it("parses @event declarations into the contract IR", () => {
    const c = parse(PAYMENTS).contracts[0]!;
    expect(c.events.length).toBe(1);
    const ev = c.events[0]!;
    expect(ev.name).toBe("Paid");
    expect(ev.params.map((p) => p.name)).toEqual(["from", "to", "amount", "memo"]);
    expect(ev.params.map((p) => p.indexed)).toEqual([true, true, false, false]);
    // Indexed<Address> unwraps to the underlying type
    expect(ev.params[0]!.type).toEqual({ kind: "primitive", name: "address" });
    expect(ev.params[2]!.type).toEqual({ kind: "primitive", name: "uint256" });
  });

  it("does not treat an @event member as a function", () => {
    const c = parse(PAYMENTS).contracts[0]!;
    expect(c.functions.map((f) => f.name)).toEqual(["pay"]);
  });

  it("emits a Solidity event declaration with indexed params and no data location", () => {
    const sol = emitProgram(parse(PAYMENTS))[0]!.solidity;
    expect(sol).toContain("event Paid(address indexed from, address indexed to, uint256 amount, string memo);");
    // a data location here is invalid Solidity
    expect(sol).not.toContain("string memory memo)");
  });

  it("lowers emit(...) to a Solidity emit statement, not a call", () => {
    const sol = emitProgram(parse(PAYMENTS))[0]!.solidity;
    expect(sol).toContain('emit Paid(msg.sender, to, amount, "thanks");');
    expect(sol).not.toMatch(/emit\(/);
  });

  it("rejects more than 3 indexed parameters", () => {
    const program = parse(`
@contract
export class E {
  @event Four(a: Indexed<Address>, b: Indexed<Address>, c: Indexed<Address>, d: Indexed<Address>): void {}
}
`);
    const d = validateProgram(program).find((x) => x.rule === "event-too-many-indexed");
    expect(d).toBeDefined();
    expect(d!.severity).toBe("error");
    expect(d!.loc?.file.endsWith(".ts")).toBe(true);
  });

  it("rejects emit of an undeclared event", () => {
    const program = parse(`
@contract
export class E {
  @external
  go(): void { emit(NeverDeclared(1n)); }
}
`);
    const d = validateProgram(program).find((x) => x.rule === "undeclared-event");
    expect(d).toBeDefined();
    expect(d!.message).toContain("NeverDeclared");
  });

  it("counts an emit statement as satisfying state-mutation-without-event", () => {
    const program = parse(PAYMENTS);
    const d = validateProgram(program).filter((x) => x.rule === "state-mutation-without-event");
    expect(d).toEqual([]);
  });

  it("makes the event-indexed-hint pass reachable", () => {
    const program = parse(`
@contract
export class E {
  @event Paid(to: Address, amount: bigint): void {}
}
`);
    const reports = optimizeProgram(program);
    const hints = reports.flatMap((r) => r.changes).filter((c) => c.pass === "event-indexed-hint");
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]!.detail).toContain("Paid.to");
  });
});

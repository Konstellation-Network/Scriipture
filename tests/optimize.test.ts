import { describe, it, expect } from "bun:test";
import path from "node:path";
import { parseContractFiles } from "../src/parser/parse";
import { optimizeProgram } from "../src/optimizer/passes";
import { emitProgram } from "../src/emitter/emit";

const ROOT = path.resolve(__dirname, "..");

describe("optimizer — mutating passes", () => {
  it("zero-init-strip removes redundant `= 0n` from Vault.totalDeposits", () => {
    const { program } = parseContractFiles([path.join(ROOT, "examples/vault/Vault.ts")]);
    optimizeProgram(program);
    const sol = emitProgram(program)[0]!.solidity;
    expect(sol).not.toMatch(/totalDeposits = 0;/);
    expect(sol).toContain("uint256 public totalDeposits;");
  });

  it("constant marks Counter.count as not constant (it is mutated)", () => {
    const { program } = parseContractFiles([path.join(ROOT, "examples/counter/Counter.ts")]);
    optimizeProgram(program);
    const v = program.contracts[0]!.stateVars.find((v) => v.name === "count")!;
    expect(v.mutability).toBeUndefined();
  });

  it("custom-errors converts `require(x, \"msg\")` to revert", () => {
    const { program } = parseContractFiles([path.join(ROOT, "tests/contracts/RequireToError.ts")]);
    optimizeProgram(program);
    const c = program.contracts[0]!;
    expect(c.errors.length).toBeGreaterThanOrEqual(1);
    const sol = emitProgram(program)[0]!.solidity;
    expect(sol).toContain("error ");
    expect(sol).toContain("revert ");
  });
});

import { packSlots, countStorageSlots, computePackedLayout } from "../src/optimizer/pack-slots";
import type { IRContract, IRStateVar, IRType } from "../src/ir/types";

function sv(name: string, type: IRType, mutability?: "constant" | "immutable"): IRStateVar {
  return { name, type, decorators: [], mutability };
}
const prim = (name: "uint256" | "bool" | "address" | "string"): IRType => ({ kind: "primitive", name });
function contractWith(stateVars: IRStateVar[]): IRContract {
  return { name: "T", bases: [], stateVars, functions: [], errors: [], events: [], structs: [], enums: [], sourceFile: "T.ts" };
}

describe("optimizer — pack-slots", () => {
  it("is advisory by default: reports the saving but leaves state var order untouched", () => {
    const { program } = parseContractFiles([path.join(ROOT, "tests/contracts/PackSlots.ts")]);
    const before = program.contracts[0]!.stateVars.map((v) => v.name);
    const [report] = optimizeProgram(program);
    const after = program.contracts[0]!.stateVars.map((v) => v.name);
    expect(after).toEqual(before);

    const hint = report!.changes.find((c) => c.pass === "pack-slots")!;
    expect(hint).toBeDefined();
    expect(hint.applied).toBe(false);
    expect(hint.detail).toContain("4 storage slot(s) (currently 6)");
  });

  it("reorders only when asked, and excludes constants from the layout", () => {
    const { program } = parseContractFiles([path.join(ROOT, "tests/contracts/PackSlots.ts")]);
    const [report] = optimizeProgram(program, { reorderStorage: true });
    const c = program.contracts[0]!;
    const hint = report!.changes.find((ch) => ch.pass === "pack-slots")!;
    expect(hint.applied).toBe(true);

    const names = c.stateVars.map((v) => v.name);
    expect(names.slice(0, 1)).toEqual(["FEE"]); // constant: no slot, kept in front
    expect(names.slice(1, 4)).toEqual(["flagA", "flagB", "flagC"]); // three bools share one slot
    expect(names[names.length - 1]).toBe("balances"); // mapping: full slot, last
    expect(countStorageSlots(c.stateVars)).toBe(4);
    expect(c.stateVars.find((v) => v.name === "FEE")!.mutability).toBe("constant");

    const sol = emitProgram(program)[0]!.solidity;
    expect(sol.indexOf("bool public flagC")).toBeLessThan(sol.indexOf("uint256 public supply"));
  });

  it("stays silent when solc already packs the declared order", () => {
    // address + bool share slot 0, uint256 takes slot 1: nothing to gain.
    const c = contractWith([sv("owner", prim("address")), sv("paused", prim("bool")), sv("total", prim("uint256"))]);
    expect(countStorageSlots(c.stateVars)).toBe(2);
    expect(packSlots(c, {})).toEqual([]);
    expect(packSlots(c, { reorderStorage: true })).toEqual([]);
  });

  it("does not count immutables or constants as slots", () => {
    const c = contractWith([
      sv("a", prim("bool")),
      sv("owner", prim("address"), "immutable"),
      sv("FEE", prim("uint256"), "constant"),
      sv("b", prim("bool")),
    ]);
    expect(countStorageSlots(c.stateVars)).toBe(1);
    expect(packSlots(c, {})).toEqual([]);
  });

  it("treats string and bytes as full-slot dynamic types", () => {
    const layout = computePackedLayout([sv("a", prim("bool")), sv("name", prim("string")), sv("b", prim("bool"))]);
    expect(layout.slotsBefore).toBe(3);
    expect(layout.slotsAfter).toBe(2);
    expect(layout.order.map((v) => v.name)).toEqual(["a", "b", "name"]);
  });
});

import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseContractFiles } from "../src/parser/parse";
import { validateProgram } from "../src/validator/rules";
import { isSolidityReserved } from "../src/validator/reserved";

const ROOT = path.resolve(__dirname, "..");

function validateSource(src: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-reserved-"));
  const file = path.join(dir, "R.ts");
  fs.writeFileSync(file, src, "utf8");
  const { program } = parseContractFiles([file]);
  const diags = validateProgram(program);
  fs.rmSync(dir, { recursive: true, force: true });
  return diags.filter((d) => d.rule === "solidity-reserved-identifier");
}

describe("solidity-reserved-identifier", () => {
  it("flags reserved words in every identifier position", () => {
    const diags = validateSource(`
@contract
export class R {
  reference: bigint = 0n;

  @external
  match(payable: bigint): void {
    const promise = payable + 1n;
    this.reference = promise;
  }
}
`);
    const messages = diags.map((d) => d.message).join("\n");
    expect(messages).toContain('state variable "reference"');
    expect(messages).toContain('function "match"');
    expect(messages).toContain('parameter "payable"');
    expect(messages).toContain('local variable "promise"');
    expect(diags.every((d) => d.severity === "error")).toBe(true);
    // reported against the TypeScript source, not generated .sol
    expect(diags.every((d) => d.loc?.file.endsWith(".ts"))).toBe(true);
  });

  it("does not flag ordinary names or shadowable Solidity globals", () => {
    const diags = validateSource(`
@contract
export class R {
  balance: bigint = 0n;

  @external
  withdraw(amount: bigint): void {
    this.balance = this.balance - amount;
  }
}
`);
    expect(diags).toEqual([]);
  });

  it("covers sized type names but not arbitrary identifiers", () => {
    expect(isSolidityReserved("uint128")).toBe(true);
    expect(isSolidityReserved("bytes32")).toBe(true);
    expect(isSolidityReserved("fixed128x18")).toBe(true);
    expect(isSolidityReserved("uint257")).toBe(false);
    expect(isSolidityReserved("balance")).toBe(false);
  });

  it("leaves the shipped examples clean", () => {
    const files = fs.readdirSync(path.join(ROOT, "examples"), { recursive: true } as any) as string[];
    const contracts = files
      .filter((f) => typeof f === "string" && f.endsWith(".ts"))
      .map((f) => path.join(ROOT, "examples", f));
    const { program } = parseContractFiles(contracts);
    const diags = validateProgram(program).filter((d) => d.rule === "solidity-reserved-identifier");
    expect(diags).toEqual([]);
  });
});

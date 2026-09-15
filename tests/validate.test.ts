import { describe, it, expect } from "bun:test";
import path from "node:path";
import { parseContractFiles } from "../src/parser/parse";
import { validateProgram } from "../src/validator/rules";

const ROOT = path.resolve(__dirname, "..");

describe("validator", () => {
  it("clean ERC20 has no errors", () => {
    const { program } = parseContractFiles([path.join(ROOT, "examples/erc20-token/MyToken.ts")]);
    const diagnostics = validateProgram(program);
    const errors = diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("clean Vault has no errors", () => {
    const { program } = parseContractFiles([path.join(ROOT, "examples/vault/Vault.ts")]);
    const diagnostics = validateProgram(program);
    const errors = diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });
});

describe("validator — require-checked-address", () => {
  const load = () => {
    const { program } = parseContractFiles([path.join(ROOT, "tests/contracts/Payout.ts")]);
    return program;
  };
  const hits = (diags: ReturnType<typeof validateProgram>) =>
    diags.filter((d) => d.rule === "require-checked-address").map((d) => d.message);

  it("flags Address params that reach transfer/pullPayment without validate()", () => {
    const msgs = hits(validateProgram(load()));
    expect(msgs.some((m) => m.includes('"to"') && m.includes('"payRaw"'))).toBe(true);
    expect(msgs.some((m) => m.includes('"dest"') && m.includes('"payAlias"'))).toBe(true);
    expect(msgs.some((m) => m.includes('"to"') && m.includes("pullPayment()") && m.includes('"queueRaw"'))).toBe(true);
    expect(msgs).toHaveLength(3);
  });

  it("accepts validate(), CheckedAddress params, msg.sender and @allowZeroAddress", () => {
    const msgs = hits(validateProgram(load()));
    for (const clean of ["payChecked", "payInline", "payTyped", "refund", "burn"]) {
      expect(msgs.some((m) => m.includes(`"${clean}"`))).toBe(false);
    }
  });

  it("is a warning normally and an error in secure mode", () => {
    const plain = validateProgram(load()).filter((d) => d.rule === "require-checked-address");
    expect(plain.every((d) => d.severity === "warning")).toBe(true);
    const secure = validateProgram(load(), { secure: true }).filter((d) => d.rule === "require-checked-address");
    expect(secure.every((d) => d.severity === "error")).toBe(true);
    expect(secure).toHaveLength(3);
  });

  it("validate() lowers to a runtime zero-address check, not a no-op", () => {
    const { emitProgram } = require("../src/emitter/emit");
    const sol: string = emitProgram(load())[0]!.solidity;
    expect(sol).toContain("address safe = _validateAddr(to);");
    expect(sol).toContain('require(a != address(0), "zero address");');
  });
});

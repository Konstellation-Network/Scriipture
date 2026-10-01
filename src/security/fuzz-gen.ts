import type { IRContract, IRFunction, IRParam, IRType } from "../ir/types";
import { resolveContract } from "../mapper/decorators";
import { solidityType } from "../mapper/types";

export interface FuzzHarness {
  filename: string;
  solidity: string;
}

export function generateFuzzHarness(contract: IRContract): FuzzHarness | null {
  const resolution = resolveContract(contract);
  const ctor = contract.functions.find((f) => f.isConstructor);
  if (ctor && ctor.params.length > 0) return null;

  // An abstract contract cannot be deployed into a harness at all.
  if (contract.isAbstract) return null;
  const publicFns = contract.functions.filter((fn) =>
    !fn.isConstructor && !fn.isAssembly && !fn.special && !fn.isAbstract &&
    !fn.decorators.some((d) => d.name === "internal" || d.name === "private"),
  );

  // A method with no parameters has nothing to fuzz, and a harness with no
  // test function makes `forge test --match-contract FuzzAuto` exit 1 with
  // "No tests match", which reads as a gate failure rather than "nothing to do".
  const fuzzable = publicFns.filter((fn) => fn.params.length > 0 && fn.params.every((p) => isFuzzable(contract, p.type)));
  if (fuzzable.length === 0) return null;

  const invariantFns = publicFns.filter((fn) =>
    fn.decorators.some((d) => d.name === "invariant") ||
    autoInvariantFor(contract, fn) !== undefined,
  );

  const lines: string[] = [];
  lines.push("// SPDX-License-Identifier: MIT");
  lines.push("pragma solidity ^0.8.20;");
  lines.push("");
  lines.push(`import "forge-std/Test.sol";`);
  lines.push(`import "../src/${contract.name}.sol";`);
  lines.push("");
  lines.push(`contract ${contract.name}FuzzAuto is Test {`);
  lines.push(`    ${contract.name} internal _target;`);
  lines.push("");
  lines.push(`    function setUp() public {`);
  lines.push(`        _target = new ${contract.name}();`);
  lines.push(`    }`);
  lines.push("");

  for (const fn of fuzzable) {
    lines.push(...fuzzMethod(contract, fn, invariantFns));
    lines.push("");
  }

  for (const fn of invariantFns) {
    lines.push(...invariantMethod(contract, fn));
    lines.push("");
  }

  if (lines[lines.length - 1] === "") lines.pop();
  lines.push("}");
  lines.push("");

  return { filename: `${contract.name}.fuzz.t.sol`, solidity: lines.join("\n") };
}

/**
 * An enum nested inside a struct field or an array element cannot be fuzzed
 * safely: the ABI decoder rejects an out-of-range enum before the test body
 * runs, so there is nowhere to put a `vm.assume`. (A top-level enum parameter
 * is fine -- fuzzMethod takes it as a bounded uint8.) Skip those methods
 * rather than emit a harness that fails for reasons that are not the
 * contract's fault.
 */
function isFuzzable(contract: IRContract, type: IRType, seen = new Set<string>()): boolean {
  if (type.kind === "struct") {
    if (seen.has(type.name)) return true;
    seen.add(type.name);
    const decl = contract.structs.find((s) => s.name === type.name);
    if (!decl) return false;
    return decl.fields.every((f) => f.type.kind !== "enum" && isFuzzable(contract, f.type, seen));
  }
  if (type.kind === "array") return type.element.kind !== "enum" && isFuzzable(contract, type.element, seen);
  if (type.kind === "mapping") return false;
  return true;
}

function fuzzMethod(contract: IRContract, fn: IRFunction, invariants: IRFunction[]): string[] {
  const paramSigs: string[] = [];
  const callArgs: string[] = [];
  const preamble: string[] = [];

  for (const p of fn.params) {
    if (p.type.kind === "enum") {
      // Take the raw integer so the bound can be assumed; the ABI decoder would
      // revert on an out-of-range enum before any assume in the body could run.
      const decl = contract.enums.find((e) => e.name === (p.type as { name: string }).name);
      const raw = `${p.name}Raw`;
      const qualified = `${contract.name}.${p.type.name}`;
      paramSigs.push(`uint8 ${raw}`);
      if (decl) preamble.push(`        vm.assume(${raw} < ${decl.members.length});`);
      preamble.push(`        ${qualified} ${p.name} = ${qualified}(${raw});`);
      callArgs.push(p.name);
      continue;
    }
    paramSigs.push(`${solidityFuzzType(p.type, contract.name)} ${p.name}`);
    callArgs.push(p.name);
    if (p.type.kind === "primitive" && p.type.name === "address") {
      preamble.push(`        vm.assume(${p.name} != address(0));`);
    }
  }

  const paramSig = paramSigs.join(", ");
  const cap = fn.name.charAt(0).toUpperCase() + fn.name.slice(1);
  const lines: string[] = [];
  lines.push(`    function testFuzz_${cap}(${paramSig}) public {`);
  lines.push(...preamble);
  const callArgsStr = callArgs.join(", ");
  const isView = fn.decorators.some((d) => d.name === "view" || d.name === "pure");
  if (isView) {
    lines.push(`        _target.${fn.name}(${callArgsStr});`);
  } else {
    lines.push(`        try _target.${fn.name}(${callArgsStr}) {} catch {}`);
  }
  for (const inv of invariants) {
    lines.push(`        assertTrue(this.${inv.name}_invariant(), "${inv.name} invariant violated");`);
  }
  lines.push(`    }`);
  return lines;
}

function invariantMethod(contract: IRContract, fn: IRFunction): string[] {
  const lines: string[] = [];
  const auto = autoInvariantFor(contract, fn);
  if (auto) {
    lines.push(`    function ${fn.name}_invariant() public view returns (bool) {`);
    lines.push(`        return ${auto};`);
    lines.push(`    }`);
  } else {
    lines.push(`    function ${fn.name}_invariant() public view returns (bool) {`);
    lines.push(`        return _target.${fn.name}();`);
    lines.push(`    }`);
  }
  return lines;
}

function autoInvariantFor(_contract: IRContract, _fn: IRFunction): string | undefined {
  return undefined;
}

/**
 * Struct and enum names are members of the contract, so inside the harness --
 * which does not inherit it -- they must be written `Governance.Proposal`, not
 * `Proposal`, or solc reports "Identifier not found or not unique".
 */
function qualifyTypes(t: IRType, contractName: string): IRType {
  switch (t.kind) {
    case "struct":
    case "enum":
      return { ...t, name: `${contractName}.${t.name}` };
    case "array":
      return { kind: "array", element: qualifyTypes(t.element, contractName) };
    case "mapping":
      return { kind: "mapping", key: qualifyTypes(t.key, contractName), value: qualifyTypes(t.value, contractName) };
    default:
      return t;
  }
}

function solidityFuzzType(t: IRType, contractName: string): string {
  return solidityType(qualifyTypes(t, contractName), "memory");
}

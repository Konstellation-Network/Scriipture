import type {
  IRContract,
  IREnumDecl,
  IRErrorDecl,
  IREventDecl,
  IRFunction,
  IRParam,
  IRProgram,
  IRStateVar,
  IRStructDecl,
} from "../ir/types";
import { resolveContract, type ContractResolution } from "../mapper/decorators";
import { emitExpression, type EmitContext } from "../mapper/expressions";
import { emitStatements } from "../mapper/statements";
import { solidityType } from "../mapper/types";
import { functionScope } from "../mapper/infer";

export interface EmitOptions {
  pragma?: string;
  license?: string;
}

const DEFAULTS: Required<EmitOptions> = {
  pragma: "^0.8.20",
  license: "MIT",
};

export interface EmittedContract {
  name: string;
  sourceFile: string;
  solidity: string;
}

export function emitProgram(program: IRProgram, opts: EmitOptions = {}): EmittedContract[] {
  return program.contracts.map((c) => ({
    name: c.name,
    sourceFile: c.sourceFile,
    solidity: emitContract(c, opts),
  }));
}

export function emitContract(contract: IRContract, opts: EmitOptions = {}): string {
  const o = { ...DEFAULTS, ...opts };
  const resolution = resolveContract(contract);
  const stateVarNames = new Set(contract.stateVars.map((v) => v.name));
  const stateVarTypes = new Map(contract.stateVars.map((v) => [v.name, v.type]));
  const structs = new Map(contract.structs.map((s) => [s.name, s]));
  const ctx: EmitContext = { stateVarNames, stateVarTypes, structs };

  const lines: string[] = [];
  lines.push(`// SPDX-License-Identifier: ${o.license}`);
  lines.push(`pragma solidity ${o.pragma};`);
  lines.push("");

  const imports = Array.from(resolution.imports).sort();
  for (const imp of imports) lines.push(`import "${imp}";`);
  if (imports.length > 0) lines.push("");

  if (contract.natspec) for (const ln of contract.natspec) lines.push(`/// ${ln}`);

  const header = resolution.inheritedContracts.length > 0
    ? `contract ${contract.name} is ${resolution.inheritedContracts.join(", ")} {`
    : `contract ${contract.name} {`;
  lines.push(header);

  for (const en of contract.enums) lines.push(...emitEnum(en));
  if (contract.enums.length > 0) lines.push("");

  for (const st of contract.structs) lines.push(...emitStruct(st));
  if (contract.structs.length > 0) lines.push("");

  for (const err of contract.errors) lines.push(...emitError(err));
  if (contract.errors.length > 0) lines.push("");

  for (const ev of contract.events) lines.push(...emitEvent(ev));
  if (contract.events.length > 0) lines.push("");

  for (const v of contract.stateVars) lines.push(...emitStateVar(v, ctx));
  if (contract.stateVars.length > 0) lines.push("");

  const constructorFn = contract.functions.find((f) => f.isConstructor);
  const needsSynthesizedCtor = !constructorFn && resolution.inheritedContracts.some((b) => BASE_CONSTRUCTOR_ARGS[b] !== undefined);
  if (constructorFn) {
    lines.push(...emitConstructor(constructorFn, contract, resolution, ctx));
    lines.push("");
  } else if (needsSynthesizedCtor) {
    const calls: string[] = [];
    for (const base of resolution.inheritedContracts) {
      const args = BASE_CONSTRUCTOR_ARGS[base];
      if (args !== undefined) calls.push(`${base}(${args})`);
    }
    lines.push(`    constructor() ${calls.join(" ")} {}`);
    lines.push("");
  }

  for (const fn of contract.functions) {
    if (fn.isConstructor) continue;
    lines.push(...emitFunction(fn, resolution, ctx));
    lines.push("");
  }

  const helpers = detectHelpers(contract);
  if (helpers.size > 0) lines.push(...emitHelpers(helpers));

  if (lines[lines.length - 1] === "") lines.pop();
  lines.push("}");
  lines.push("");

  return lines.join("\n");
}

function detectHelpers(contract: IRContract): Set<"_validateAddr" | "_pullPayment"> {
  const found = new Set<"_validateAddr" | "_pullPayment">();
  const walk = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (node.kind === "call" && node.callee?.kind === "identifier") {
      if (node.callee.name === "validate") found.add("_validateAddr");
      if (node.callee.name === "pullPayment") found.add("_pullPayment");
    }
    for (const k of Object.keys(node)) {
      const v = (node as any)[k];
      if (Array.isArray(v)) for (const it of v) walk(it);
      else if (v && typeof v === "object") walk(v);
    }
  };
  for (const fn of contract.functions) for (const stmt of fn.body) walk(stmt);
  for (const v of contract.stateVars) if (v.initializer) walk(v.initializer);
  return found;
}

function emitHelpers(set: Set<"_validateAddr" | "_pullPayment">): string[] {
  const lines: string[] = [];
  if (set.has("_validateAddr")) {
    lines.push("    function _validateAddr(address a) internal pure returns (address) {");
    lines.push("        require(a != address(0), \"zero address\");");
    lines.push("        return a;");
    lines.push("    }");
    lines.push("");
  }
  if (set.has("_pullPayment")) {
    lines.push("    mapping(address => uint256) private _pendingPulls;");
    lines.push("");
    lines.push("    function _pullPayment(address recipient, uint256 amount) internal {");
    lines.push("        _pendingPulls[recipient] += amount;");
    lines.push("    }");
    lines.push("");
    lines.push("    function withdrawPayment() external {");
    lines.push("        uint256 amount = _pendingPulls[msg.sender];");
    lines.push("        require(amount > 0, \"nothing to withdraw\");");
    lines.push("        _pendingPulls[msg.sender] = 0;");
    lines.push("        (bool ok, ) = msg.sender.call{value: amount}(\"\");");
    lines.push("        require(ok, \"transfer failed\");");
    lines.push("    }");
    lines.push("");
  }
  return lines;
}

function emitEnum(en: IREnumDecl): string[] {
  const lines: string[] = [];
  if (en.natspec) for (const ln of en.natspec) lines.push(`    /// ${ln}`);
  lines.push(`    enum ${en.name} { ${en.members.join(", ")} }`);
  return lines;
}

function emitStruct(st: IRStructDecl): string[] {
  const lines: string[] = [];
  if (st.natspec) for (const ln of st.natspec) lines.push(`    /// ${ln}`);
  lines.push(`    struct ${st.name} {`);
  // Struct fields take no data location -- "storage" yields the bare type.
  for (const f of st.fields) lines.push(`        ${solidityType(f.type)} ${f.name};`);
  lines.push("    }");
  return lines;
}

function emitError(err: IRErrorDecl): string[] {
  // Error parameters take no data location -- "storage" yields the bare type.
  const params = err.params.map((p) => `${solidityType(p.type)} ${p.name}`).join(", ");
  return [`    error ${err.name}(${params});`];
}

function emitEvent(ev: IREventDecl): string[] {
  // Event parameters take no data location either.
  const params = ev.params
    .map((p) => `${solidityType(p.type)}${p.indexed ? " indexed" : ""} ${p.name}`)
    .join(", ");
  return [`    event ${ev.name}(${params});`];
}

function emitStateVar(v: IRStateVar, ctx: EmitContext): string[] {
  const lines: string[] = [];
  if (v.natspec) for (const ln of v.natspec) lines.push(`    /// ${ln}`);

  const visibility = v.visibility ?? "public";
  const typeStr = solidityType(v.type, "storage");
  const mutability = v.mutability ? ` ${v.mutability}` : "";
  const initStr = v.initializer && !shouldSkipInitializer(v) ? ` = ${emitExpression(v.initializer, ctx)}` : "";
  lines.push(`    ${typeStr} ${visibility}${mutability} ${v.name}${initStr};`);
  return lines;
}

function shouldSkipInitializer(v: IRStateVar): boolean {
  if (v.type.kind === "mapping") return true;
  if (v.type.kind === "array") return true;
  if (v.initializer?.kind === "new") return true;
  return false;
}

const BASE_CONSTRUCTOR_ARGS: Record<string, string> = {
  Ownable: "msg.sender",
};

function emitConstructor(
  fn: IRFunction,
  _contract: IRContract,
  resolution: ContractResolution,
  ctx: EmitContext,
): string[] {
  const paramStr = fn.params.map((p) => paramSignature(p)).join(", ");

  const chainedCalls: string[] = [];
  if (fn.superCall) {
    chainedCalls.push(
      `${fn.superCall.baseName}(${fn.superCall.args.map((a) => emitExpression(a, ctx)).join(", ")})`,
    );
  }
  for (const base of resolution.inheritedContracts) {
    if (fn.superCall && fn.superCall.baseName === base) continue;
    const defaults = BASE_CONSTRUCTOR_ARGS[base];
    if (defaults !== undefined) chainedCalls.push(`${base}(${defaults})`);
  }

  const superStr = chainedCalls.length > 0 ? " " + chainedCalls.join(" ") : "";

  const lines: string[] = [];
  if (fn.natspec) for (const ln of fn.natspec) lines.push(`    /// ${ln}`);
  lines.push(`    constructor(${paramStr})${superStr} {`);
  lines.push(...emitStatements(fn.body, withLocals(ctx, fn), "        "));
  lines.push("    }");
  return lines;
}

function emitFunction(fn: IRFunction, resolution: ContractResolution, ctx: EmitContext): string[] {
  const res = resolution.functions.get(fn);
  if (!res) return [];

  const params = fn.params.map((p) => paramSignature(p)).join(", ");
  const visibility = res.visibility ?? "public";
  const mutability = res.stateMutability ? ` ${res.stateMutability}` : "";
  const modifiers = res.modifiers.length > 0 ? " " + res.modifiers.join(" ") : "";

  const isVoid = fn.returnType.kind === "primitive" && fn.returnType.name === "void";
  const returns = isVoid ? "" : ` returns (${solidityType(fn.returnType, "memory")})`;

  const lines: string[] = [];
  if (fn.natspec) for (const ln of fn.natspec) lines.push(`    /// ${ln}`);
  lines.push(`    function ${fn.name}(${params}) ${visibility}${mutability}${modifiers}${returns} {`);

  if (fn.isAssembly && fn.assemblyBody !== undefined) {
    lines.push("        assembly {");
    for (const ln of fn.assemblyBody.split("\n")) {
      const trimmed = ln.trim();
      if (trimmed) lines.push(`            ${trimmed}`);
    }
    lines.push("        }");
  } else {
    lines.push(...emitStatements(fn.body, withLocals(ctx, fn), "        "));
  }

  lines.push("    }");
  return lines;
}

/**
 * The emit context plus this function's parameters. Locals enter the context
 * block by block as `emitStatements` declares them, the same way `walkScoped`
 * does for the validator.
 */
function withLocals(ctx: EmitContext, fn: IRFunction): EmitContext {
  return functionScope(ctx, fn);
}

function paramSignature(p: IRParam): string {
  const location = p.location ?? "memory";
  const baseType = solidityType(p.type, location);
  return `${baseType} ${p.name}`;
}

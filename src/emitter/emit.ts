import path from "node:path";
import type {
  IRContract,
  IREnumDecl,
  IRErrorDecl,
  IREventDecl,
  IRExpression,
  IRFileScope,
  IRFunction,
  IRInterface,
  IRParam,
  IRProgram,
  IRStateVar,
  IRStatement,
  IRStructDecl,
  IRType,
  IRValueTypeDecl,
} from "../ir/types";
import { walkExpressionsInStatement, walkStatements } from "../optimizer/walk";
import { ancestorsOf } from "../mapper/lineage";
import { resolveContract, resolveFunctionDecorators, standardImportFor, type ContractResolution } from "../mapper/decorators";
import { emitExpression, type EmitContext } from "../mapper/expressions";
import { emitStatements } from "../mapper/statements";
import { solidityType } from "../mapper/types";
import { contractTypeEnv, fileTypeEnv, functionScope } from "../mapper/infer";

export interface EmitOptions {
  pragma?: string;
  license?: string;
  /**
   * Contracts defined elsewhere in the same program. A base named here is
   * emitted to its own `<Name>.sol` beside this one and imported from it;
   * without that, `contract Child is Base` reaches solc with Base undefined.
   */
  knownContracts?: Set<string>;
  /**
   * The whole build. With it, `virtual` / `override` are inferred across
   * contracts, and calls into other contracts and interfaces are typed.
   */
  program?: IRProgram;
  /** The shared definitions file of each source file, from `sharedDefinitions`. */
  defs?: Map<string, SharedDefinitions>;
}

const DEFAULTS: Required<Omit<EmitOptions, "knownContracts" | "program" | "defs">> = {
  pragma: "^0.8.20",
  license: "MIT",
};

export interface EmittedContract {
  name: string;
  sourceFile: string;
  solidity: string;
  /**
   * `interface` for a Solidity interface file, `defs` for a source file's
   * shared definitions (free functions, constants, and the structs, enums and
   * value types more than one unit needs); absent for a contract or library.
   */
  kind?: "interface" | "defs";
}

/**
 * One `.sol` per contract, in `program.contracts` order, followed by one per
 * interface. Callers that pair the result with `program.contracts` by index
 * keep working; callers that write files must write all of them, since a
 * contract imports the interfaces it uses from `./<Name>.sol`.
 */
export function emitProgram(program: IRProgram, opts: EmitOptions = {}): EmittedContract[] {
  const interfaces = usedInterfaces(program);
  const knownContracts = opts.knownContracts ?? new Set([...program.contracts.map((c) => c.name), ...interfaces.map((i) => i.name)]);
  const defs = sharedDefinitions(program, interfaces);
  const o = { ...opts, knownContracts, program, defs };
  return [
    ...program.contracts.map((c) => ({ name: c.name, sourceFile: c.sourceFile, solidity: emitContract(c, o) })),
    ...interfaces.map((i) => ({ name: i.name, sourceFile: i.sourceFile, solidity: emitInterface(i, o), kind: "interface" as const })),
    ...[...defs.values()].map((d) => ({ name: d.name, sourceFile: d.scope.sourceFile, solidity: emitDefinitions(d, o), kind: "defs" as const })),
  ];
}

/**
 * What one source file declares at Solidity's file level, and the name of the
 * `.sol` that holds it. A struct, enum or value type normally lives inside
 * each contract of its file; one that a library, an interface, a free
 * function or a file constant uses must be visible outside any contract, so
 * it moves here and the file's contracts import it instead of declaring it.
 */
export interface SharedDefinitions {
  name: string;
  scope: IRFileScope;
  structs: IRStructDecl[];
  enums: IREnumDecl[];
  valueTypes: IRValueTypeDecl[];
  /** Names of `structs`, `enums` and `valueTypes`, which contracts in the file must not redeclare. */
  typeNames: Set<string>;
}

export function sharedDefinitions(program: IRProgram, interfaces = usedInterfaces(program)): Map<string, SharedDefinitions> {
  const out = new Map<string, SharedDefinitions>();
  for (const scope of program.files ?? []) {
    const fileTypes = new Set([...scope.structs, ...scope.enums, ...scope.valueTypes].map((t) => t.name));
    const users = [
      ...interfaces.filter((i) => i.sourceFile === scope.sourceFile).map((i) => referencedTypeNames(i.functions, [])),
      ...program.contracts.filter((c) => c.kind === "library" && c.sourceFile === scope.sourceFile).map((c) => referencedTypeNames(c.functions, c.stateVars)),
      referencedTypeNames(scope.functions, scope.constants),
    ];
    const needed = new Set<string>();
    const pending = users.flatMap((u) => [...u]).filter((n) => fileTypes.has(n));
    // A shared struct's fields must be visible where it is declared, too.
    while (pending.length > 0) {
      const n = pending.pop()!;
      if (needed.has(n)) continue;
      needed.add(n);
      const st = scope.structs.find((x) => x.name === n);
      if (st) for (const f of st.fields) for (const r of typeNames(f.type)) if (fileTypes.has(r)) pending.push(r);
    }
    if (needed.size === 0 && scope.functions.length === 0 && scope.constants.length === 0) continue;
    out.set(scope.sourceFile, {
      name: `${path.basename(scope.sourceFile).replace(/\.[cm]?tsx?$/, "")}.defs`,
      scope,
      structs: scope.structs.filter((x) => needed.has(x.name)),
      enums: scope.enums.filter((x) => needed.has(x.name)),
      valueTypes: scope.valueTypes.filter((x) => needed.has(x.name)),
      typeNames: needed,
    });
  }
  return out;
}

/** The names a type refers to: structs, enums, value types, contracts and interfaces. */
function typeNames(t: IRType): string[] {
  switch (t.kind) {
    case "struct": case "enum": case "custom": return [t.name];
    case "mapping": return [...typeNames(t.key), ...typeNames(t.value)];
    case "array": return typeNames(t.element);
    case "tuple": return t.elements.flatMap(typeNames);
    case "function": return [...t.params, ...t.returns].flatMap(typeNames);
    default: return [];
  }
}

/** A source file's shared definitions: file-level value types, enums, structs, constants and free functions. */
function emitDefinitions(d: SharedDefinitions, opts: EmitOptions): string {
  const o = { ...DEFAULTS, ...opts };
  const lines = [`// SPDX-License-Identifier: ${o.license}`, `pragma solidity ${o.pragma};`, ""];
  const refs = referencedTypeNames(d.scope.functions, d.scope.constants);
  const imports = [...refs].filter((n) => o.knownContracts?.has(n) ?? false).sort();
  for (const n of imports) lines.push(`import "./${n}.sol";`);
  if (imports.length > 0) lines.push("");
  const unindent = (ls: string[]) => ls.map((l) => l.replace(/^ {4}/, ""));
  const blocks: string[][] = [
    ...d.valueTypes.map((v) => unindent(emitValueType(v))),
    ...d.enums.map((e) => unindent(emitEnum(e))),
    ...d.structs.map((st) => unindent(emitStruct(st))),
  ];
  const fileEnv: EmitContext = { stateVarNames: new Set(), ...fileTypeEnv(d.scope, o.program) };
  if (d.scope.constants.length > 0) {
    blocks.push(d.scope.constants.flatMap((c) => {
      // solc accepts no NatSpec on a file-level constant; keep the comment as a plain one.
      const natspec = (c.natspec ?? []).map((ln) => `// ${ln}`);
      return [...natspec, `${solidityType(c.type, "storage")} constant ${c.name} = ${emitExpression(c.initializer!, fileEnv)};`];
    }));
  }
  for (const fn of d.scope.functions) {
    const res = resolveFunctionDecorators(fn.decorators);
    const params = fn.params.map((p) => paramSignature(p)).join(", ");
    const mut = res.stateMutability ? ` ${res.stateMutability}` : "";
    const fnLines = (fn.natspec ?? []).map((ln) => `/// ${ln}`);
    fnLines.push(`function ${fn.name}(${params})${mut}${returnsClause(fn.returnType)} {`);
    fnLines.push(...emitStatements(fn.body, functionScope({ ...fileEnv, returnNames: returnNames(fn) }, fn), "    "));
    fnLines.push("}");
    blocks.push(fnLines);
  }
  blocks.forEach((b, i) => { if (i > 0) lines.push(""); lines.push(...b); });
  lines.push("");
  return lines.join("\n");
}

/**
 * The interfaces the build's contracts use -- by `at<I>(…)`, a type, or
 * `implements` -- and the ones those interfaces use in turn. A method-only TS
 * interface nothing refers to is a TS-only shape (a callback type, say) and
 * is not emitted.
 */
export function usedInterfaces(program: IRProgram): IRInterface[] {
  const all = new Map((program.interfaces ?? []).map((i) => [i.name, i]));
  const used = new Set<string>();
  const pending: string[] = [];
  const mark = (names: Iterable<string>): void => {
    for (const n of names) if (all.has(n) && !used.has(n)) { used.add(n); pending.push(n); }
  };
  for (const c of program.contracts) mark([...(c.interfaces ?? []), ...referencedTypeNames(c.functions, c.stateVars)]);
  while (pending.length > 0) mark(referencedTypeNames(all.get(pending.pop()!)!.functions, []));
  return [...all.values()].filter((i) => used.has(i.name));
}

/** A Solidity interface: every function `external`, no bodies. */
export function emitInterface(iface: IRInterface, opts: EmitOptions = {}): string {
  const o = { ...DEFAULTS, ...opts };
  const lines = [`// SPDX-License-Identifier: ${o.license}`, `pragma solidity ${o.pragma};`, ""];
  const refs = referencedTypeNames(iface.functions, []);
  const imports = [...refs].filter((n) => n !== iface.name && (o.knownContracts?.has(n) ?? false)).map((n) => `./${n}.sol`);
  const defs = o.defs?.get(iface.sourceFile);
  if (defs && [...refs].some((n) => defs.typeNames.has(n))) imports.push(`./${defs.name}.sol`);
  for (const n of imports.sort()) lines.push(`import "${n}";`);
  if (imports.length > 0) lines.push("");
  if (iface.natspec) for (const ln of iface.natspec) lines.push(`/// ${ln}`);
  lines.push(`interface ${iface.name} {`);
  iface.functions.forEach((fn, i) => {
    if (i > 0) lines.push("");
    if (fn.natspec) for (const ln of fn.natspec) lines.push(`    /// ${ln}`);
    const mutability = fn.decorators.find((d) => d.name === "view" || d.name === "pure" || d.name === "payable");
    const params = fn.params.map((p) => `${solidityType(p.type, "calldata")} ${p.name}`).join(", ");
    lines.push(`    function ${fn.name}(${params}) external${mutability ? ` ${mutability.name}` : ""}${returnsClause(fn.returnType)};`);
  });
  lines.push("}", "");
  return lines.join("\n");
}

/** ` returns (T)` / ` returns (A, B)` in Solidity's spelling, or nothing for `void`. */
function returnsClause(type: IRType): string {
  if (type.kind === "primitive" && type.name === "void") return "";
  if (type.kind === "tuple" && type.names) {
    // `[amount: bigint, ok: boolean]` → `returns (uint256 amount, bool ok)`.
    return ` returns (${type.elements.map((t, i) => `${solidityType(t, "memory")}${type.names![i] ? ` ${type.names![i]}` : ""}`).join(", ")})`;
  }
  return ` returns (${solidityType(type, "memory")})`;
}

/** The names of a function's labelled return values, which its body must assign rather than redeclare. */
function returnNames(fn: IRFunction): Set<string> | undefined {
  const t = fn.returnType;
  if (t.kind !== "tuple" || !t.names) return undefined;
  return new Set(t.names.filter((n): n is string => !!n));
}

/**
 * Every type or contract name the given functions and state variables refer
 * to: in types, `new X`, `X(addr)` (from `at<X>(addr)`), and `type<X>()`.
 * Used to import the build's other contracts and interfaces.
 */
function referencedTypeNames(fns: IRFunction[], vars: IRStateVar[]): Set<string> {
  const out = new Set<string>();
  const addType = (t: IRType | undefined): void => {
    if (t) for (const n of typeNames(t)) out.add(n);
  };
  const addExpr = (e: IRExpression): void => {
    if (e.kind === "new" && !e.type) out.add(e.className);
    if (e.kind === "new") addType(e.type);
    if (e.kind === "call" && e.callee.kind === "identifier") out.add(e.callee.name);
    if (e.kind === "call") e.typeArgs?.forEach(addType);
    // `MathLib.max(a, b)`, `Price.wrap(x)`, `IERC20(t).transfer` is covered above.
    if (e.kind === "member" && e.object.kind === "identifier") out.add(e.object.name);
    if (e.kind === "object" && e.structName) out.add(e.structName);
  };
  const addStmt = (st: IRStatement): void => {
    if (st.kind === "let") addType(st.type);
    if (st.kind === "destructure") st.types?.forEach(addType);
    if (st.kind === "try") st.returns.forEach((r) => addType(r.type));
    walkExpressionsInStatement(st, addExpr);
  };
  for (const v of vars) {
    addType(v.type);
    if (v.initializer) walkExpressionsInStatement({ kind: "expression", expr: v.initializer }, addExpr);
  }
  for (const fn of fns) {
    fn.params.forEach((p) => addType(p.type));
    addType(fn.returnType);
    walkStatements(fn.body, addStmt);
    for (const d of fn.decorators) for (const a of d.args) walkExpressionsInStatement({ kind: "expression", expr: a }, addExpr);
    if (fn.superCall) for (const a of fn.superCall.args) walkExpressionsInStatement({ kind: "expression", expr: a }, addExpr);
  }
  return out;
}

/**
 * How each function of `contract` relates to the rest of the build:
 * `override` when a base in the build (or TS `override`) defines it, with the
 * bases listed when more than one inheritance path does; `virtual` when it is
 * abstract, marked `@virtual`, or redefined by a contract derived from this one.
 */
function inheritanceSpecifiers(contract: IRContract, program: IRProgram | undefined): Map<IRFunction, string> {
  const byName = new Map((program?.contracts ?? []).map((c) => [c.name, c]));
  // Same name *and* parameter types: an overload with other parameters is a different function.
  const defines = (c: IRContract, fn: IRFunction) => c.functions.some((f) => !f.isConstructor && f.name === fn.name && f.special === fn.special && sameParams(f, fn));
  /** The contracts nearest `c` (itself included) that define `fn`, along every path. */
  const nearestDefiners = (c: IRContract, fn: IRFunction, seen: Set<string>): Set<string> => {
    if (seen.has(c.name)) return new Set();
    seen.add(c.name);
    if (defines(c, fn)) return new Set([c.name]);
    const out = new Set<string>();
    for (const b of c.bases) { const base = byName.get(b); if (base) for (const n of nearestDefiners(base, fn, seen)) out.add(n); }
    return out;
  };
  const inheritsFrom = (c: IRContract, ancestor: string, seen = new Set<string>()): boolean => {
    if (seen.has(c.name)) return false;
    seen.add(c.name);
    return c.bases.some((b) => b === ancestor || (byName.has(b) && inheritsFrom(byName.get(b)!, ancestor, seen)));
  };

  const out = new Map<IRFunction, string>();
  for (const fn of contract.functions) {
    if (fn.isConstructor) continue;
    const definers = new Set<string>();
    for (const b of contract.bases) { const base = byName.get(b); if (base) for (const n of nearestDefiners(base, fn, new Set())) definers.add(n); }
    const parts: string[] = [];
    const overriddenBelow = (program?.contracts ?? []).some((c) => c !== contract && defines(c, fn) && inheritsFrom(c, contract.name));
    const isVirtual = fn.isAbstract || fn.decorators.some((d) => d.name === "virtual") || overriddenBelow;
    if (isVirtual) parts.push("virtual");
    if (definers.size > 1) parts.push(`override(${[...definers].sort().join(", ")})`);
    else if (definers.size === 1 || fn.isOverride) parts.push("override");
    if (parts.length > 0) out.set(fn, parts.join(" "));
  }
  return out;
}

function takesInternalFunction(fn: IRFunction): boolean {
  const internal = (t: IRType): boolean =>
    (t.kind === "function" && t.visibility === "internal") ||
    (t.kind === "tuple" && t.elements.some(internal)) ||
    (t.kind === "array" && internal(t.element));
  return fn.params.some((p) => internal(p.type)) || internal(fn.returnType);
}

/**
 * `constructor(side: bigint) { this.side = side; }` is ordinary TypeScript,
 * but Solidity reads both sides as the parameter -- `side = side;` -- and the
 * state variable is never written. A parameter, local or named return value
 * that shares a state variable's name is emitted with a trailing `_` instead
 * (a bare name in the body can only mean the local; the state variable is
 * always `this.side`). Parameter names are not part of the ABI selector.
 */
export function deshadow(fn: IRFunction, stateNames: Iterable<string>): IRFunction {
  const state = new Set(stateNames);
  const declared = new Set(fn.params.map((p) => p.name));
  if (fn.returnType.kind === "tuple") for (const n of fn.returnType.names ?? []) if (n) declared.add(n);
  walkStatements(fn.body, (st) => {
    if (st.kind === "let") declared.add(st.name);
    if (st.kind === "destructure") for (const n of st.names) if (n) declared.add(n);
    if (st.kind === "try") {
      for (const r of st.returns) if (r.name) declared.add(r.name);
      for (const c of st.catches) if (c.param) declared.add(c.param);
    }
  });
  const renames = new Map<string, string>();
  for (const n of declared) {
    if (!state.has(n)) continue;
    let to = `${n}_`;
    while (declared.has(to) || state.has(to)) to += "_";
    renames.set(n, to);
  }
  if (renames.size === 0) return fn;
  const r = (n: string) => renames.get(n) ?? n;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const o = node as Record<string, any>;
    if (o.kind === "identifier" && typeof o.name === "string") o.name = r(o.name);
    if (o.kind === "let" && typeof o.name === "string") o.name = r(o.name);
    if (o.kind === "destructure") o.names = o.names.map((n: string | undefined) => (n ? r(n) : n));
    if (o.kind === "try") for (const ret of o.returns) ret.name = r(ret.name);
    if (typeof o.param === "string" && Array.isArray(o.body)) o.param = r(o.param);
    // `@onlyCreator(param("id"))` names a parameter by string.
    if (o.kind === "call" && o.callee?.kind === "identifier" && o.callee.name === "param" && o.args?.[0]?.kind === "literal") o.args[0].value = r(o.args[0].value);
    for (const k of Object.keys(o)) if (k !== "loc") visit(o[k]);
  };
  const out = structuredClone(fn);
  for (const p of out.params) p.name = r(p.name);
  if (out.returnType.kind === "tuple" && out.returnType.names) out.returnType.names = out.returnType.names.map((n) => (n ? r(n) : n));
  visit(out.body);
  visit(out.decorators);
  if (out.superCall) visit(out.superCall.args);
  return out;
}

function sameParams(a: IRFunction, b: IRFunction): boolean {
  const sig = (f: IRFunction) => f.params.map((p) => solidityType(p.type)).join(",");
  return sig(a) === sig(b);
}

export function emitContract(contract: IRContract, opts: EmitOptions = {}): string {
  const o = { ...DEFAULTS, ...opts };
  const resolution = resolveContract(contract);
  const stateVarNames = new Set(contract.stateVars.map((v) => v.name));
  const ctx: EmitContext = { stateVarNames, ...contractTypeEnv(contract, o.program) };
  const specifiers = inheritanceSpecifiers(contract, o.program);
  const modifierNames = userModifierNames(contract, o.program);

  const lines: string[] = [];
  lines.push(`// SPDX-License-Identifier: ${o.license}`);
  // Transient state variables need solc 0.8.28; the default range admits older compilers.
  const needsTransient = contract.stateVars.some((v) => v.transient) && o.pragma === DEFAULTS.pragma;
  lines.push(`pragma solidity ${needsTransient ? "^0.8.28" : o.pragma};`);
  lines.push("");

  // A base that Scriipture bundles comes in through resolution.imports; one
  // defined in this program sits in its own file next to this one.
  // So is every other contract or interface it names: `new Child(…)`,
  // `at<IERC20>(t)`, a parameter of type `IERC20`, `implements IERC20`.
  const referenced = [
    ...contract.bases,
    ...(contract.interfaces ?? []),
    ...(contract.usingFor ?? []).map((u) => u.library),
    ...referencedTypeNames(contract.functions, contract.stateVars),
  ];
  const localBases = referenced
    .filter((b) => b !== contract.name && !standardImportFor(b) && (o.knownContracts?.has(b) ?? false))
    .map((b) => `./${b}.sol`);
  const defs = o.defs?.get(contract.sourceFile);
  if (defs) localBases.push(`./${defs.name}.sol`);
  const imports = Array.from(new Set([...resolution.imports, ...localBases])).sort();
  for (const imp of imports) lines.push(`import "${imp}";`);
  if (imports.length > 0) lines.push("");

  if (contract.natspec) for (const ln of contract.natspec) lines.push(`/// ${ln}`);

  // Interfaces come first: Solidity linearizes bases in the order written,
  // and an interface is the most basic of all.
  const isLibrary = contract.kind === "library";
  const parents = [...(contract.interfaces ?? []), ...resolution.inheritedContracts];
  const keyword = isLibrary ? "library" : contract.isAbstract ? "abstract contract" : "contract";
  lines.push(parents.length > 0 ? `${keyword} ${contract.name} is ${parents.join(", ")} {` : `${keyword} ${contract.name} {`);

  for (const u of contract.usingFor ?? []) lines.push(`    using ${u.library} for ${u.type ? solidityType(u.type) : "*"};`);
  if (contract.usingFor?.length) lines.push("");

  // Every contract in a file carries the file's enums and structs, but one
  // that inherits a base in the build already sees the base's copies:
  // declaring them again is "Identifier already declared". Neither does one
  // whose file declares them at file level (see sharedDefinitions). A library
  // declares none: every type its functions use is shared.
  const inherited = ancestorsOf(contract, o.program);
  const inheritedTypes = new Set(inherited.flatMap((b) => [...b.enums, ...b.structs, ...(b.valueTypes ?? [])].map((t) => t.name)));
  const own = (name: string) => !isLibrary && !inheritedTypes.has(name) && !defs?.typeNames.has(name);
  const valueTypes = (contract.valueTypes ?? []).filter((v) => own(v.name));
  const enums = contract.enums.filter((en) => own(en.name));
  const structs = contract.structs.filter((st) => own(st.name));

  for (const v of valueTypes) lines.push(...emitValueType(v));
  if (valueTypes.length > 0) lines.push("");

  for (const en of enums) lines.push(...emitEnum(en));
  if (enums.length > 0) lines.push("");

  for (const st of structs) lines.push(...emitStruct(st));
  if (structs.length > 0) lines.push("");

  for (const err of contract.errors) lines.push(...emitError(err));
  if (contract.errors.length > 0) lines.push("");

  for (const ev of contract.events) lines.push(...emitEvent(ev));
  if (contract.events.length > 0) lines.push("");

  for (const v of contract.stateVars) lines.push(...emitStateVar(v, ctx));
  if (contract.stateVars.length > 0) lines.push("");

  const constructorFn0 = contract.functions.find((f) => f.isConstructor);
  const stateNames = [...(ctx.stateVarTypes?.keys() ?? []), ...stateVarNames];
  const constructorFn = constructorFn0 && deshadow(constructorFn0, stateNames);
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
    lines.push(...emitFunction(fn, resolution, ctx, specifiers.get(fn), modifierNames, isLibrary ? "internal" : "public", stateNames));
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

function emitValueType(v: IRValueTypeDecl): string[] {
  const lines: string[] = [];
  if (v.natspec) for (const ln of v.natspec) lines.push(`    /// ${ln}`);
  lines.push(`    type ${v.name} is ${solidityType(v.underlying)};`);
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
  return [`    event ${ev.name}(${params})${ev.anonymous ? " anonymous" : ""};`];
}

function emitStateVar(v: IRStateVar, ctx: EmitContext): string[] {
  const lines: string[] = [];
  if (v.natspec) for (const ln of v.natspec) lines.push(`    /// ${ln}`);

  // An internal function pointer cannot be public: it has no ABI encoding for the getter.
  const visibility = v.visibility ?? (v.type.kind === "function" && v.type.visibility === "internal" ? "internal" : "public");
  const typeStr = solidityType(v.type, "storage");
  const mutability = v.transient ? " transient" : v.mutability ? ` ${v.mutability}` : "";
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
  lines.push(`    constructor(${paramStr})${fn.payable ? " payable" : ""}${superStr} {`);
  lines.push(...emitStatements(fn.body, withLocals(ctx, fn), "        "));
  lines.push("    }");
  return lines;
}

/**
 * Names of the `@modifier` functions this contract can apply: its own, and
 * those of its bases in the build. A decorator with one of these names applies
 * that modifier.
 */
export function userModifierNames(contract: IRContract, program?: IRProgram): Set<string> {
  const byName = new Map((program?.contracts ?? []).map((c) => [c.name, c]));
  const out = new Set<string>();
  const seen = new Set<string>();
  const visit = (c: IRContract): void => {
    if (seen.has(c.name)) return;
    seen.add(c.name);
    for (const f of c.functions) if (f.special === "modifier") out.add(f.name);
    for (const b of c.bases) { const base = byName.get(b); if (base) visit(base); }
  };
  visit(contract);
  return out;
}

/**
 * The parameter a `param("id")` modifier argument names, or undefined. A
 * decorator's arguments are evaluated when the class is defined, so TypeScript
 * cannot see the function's parameters there; `param("id")` is how
 * `@onlyCreator(param("id"))` spells Solidity's `onlyCreator(id)`.
 */
export function paramReference(e: IRExpression): string | undefined {
  if (e.kind !== "call" || e.callee.kind !== "identifier" || e.callee.name !== "param" || e.args.length !== 1) return undefined;
  const a = e.args[0]!;
  return a.kind === "literal" && a.literalType === "string" ? a.value : undefined;
}

function emitModifierArg(e: IRExpression, ctx: EmitContext): string {
  return paramReference(e) ?? emitExpression(e, ctx);
}

/** Whether a modifier body already places `_;` itself. */
function hasPlaceholder(body: IRStatement[]): boolean {
  let found = false;
  walkStatements(body, (st) => {
    if (st.kind === "expression" && st.expr.kind === "identifier" && st.expr.name === "_") found = true;
  });
  return found;
}

function emitFunction(
  fn: IRFunction,
  resolution: ContractResolution,
  ctx: EmitContext,
  inheritance: string | undefined,
  modifierNames: Set<string>,
  defaultVisibility: "public" | "internal",
  stateNames: string[] = [],
): string[] {
  const res = resolution.functions.get(fn);
  if (!res) return [];
  fn = deshadow(fn, stateNames);
  ctx = { ...ctx, returnNames: returnNames(fn) };

  const params = fn.params.map((p) => paramSignature(p)).join(", ");
  const inh = inheritance ? ` ${inheritance}` : "";
  const lines: string[] = [];
  if (fn.natspec) for (const ln of fn.natspec) lines.push(`    /// ${ln}`);

  if (fn.special === "modifier") {
    // A modifier wraps the function it is applied to at `_;`; without one
    // written, the function body runs after the modifier's checks.
    lines.push(`    modifier ${fn.name}(${params})${inh} {`);
    lines.push(...emitStatements(fn.body, withLocals(ctx, fn), "        "));
    if (!hasPlaceholder(fn.body)) lines.push("        _;");
    lines.push("    }");
    return lines;
  }

  // Built-in and user-defined modifiers, in the order the decorators were written.
  const applied: string[] = [];
  for (const d of fn.decorators) {
    if (res.modifiers.includes(d.name)) applied.push(d.name);
    else if (modifierNames.has(d.name)) applied.push(d.args.length > 0 ? `${d.name}(${d.args.map((a) => emitModifierArg(a, ctx)).join(", ")})` : d.name);
  }
  const modifiers = applied.length > 0 ? " " + applied.join(" ") : "";

  let head: string;
  if (fn.special === "receive") {
    head = `receive() external payable${inh}${modifiers}`;
  } else if (fn.special === "fallback") {
    head = `fallback() external${res.stateMutability === "payable" ? " payable" : ""}${inh}${modifiers}`;
  } else {
    // An internal function pointer has no ABI encoding, so a function taking or
    // returning one can only be called from inside: `internal` unless told otherwise.
    const visibility = res.visibility ?? (takesInternalFunction(fn) ? "internal" : defaultVisibility);
    const mutability = res.stateMutability ? ` ${res.stateMutability}` : "";
    head = `function ${fn.name}(${params}) ${visibility}${mutability}${inh}${modifiers}${returnsClause(fn.returnType)}`;
  }

  if (fn.isAbstract) {
    lines.push(`    ${head};`);
    return lines;
  }
  lines.push(`    ${head} {`);

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

import type { IRContract, IRExpression, IRFunction, IRStatement, IRStructDecl, IRType } from "../ir/types";
import { exprContains, walkStatements } from "../optimizer/walk";
import { aliasedPrimitive } from "./types";

/** Everything the emitter and validator know about identifier types at a given point. */
export interface TypeEnv {
  /** Declared type of each state variable. */
  stateVarTypes?: Map<string, IRType>;
  /** Parameters and locals of the function being emitted, annotated or inferred. */
  localTypes?: Map<string, IRType>;
  /**
   * Locals that alias storage rather than hold a copy
   * (`const p = this.proposals.get(id)` is `Proposal storage p`), so a path
   * reached through one is a storage path too.
   */
  storageLocals?: Set<string>;
  /** Structs declared alongside the contract, so field access can be typed. */
  structs?: Map<string, IRStructDecl>;
  /**
   * Return type of each of the contract's own functions, so a local bound to
   * `this.draft(id)` is typed by what `draft` returns. Without it the `uint256`
   * fallback produces `uint256 p = draft(id)`.
   */
  fnReturnTypes?: Map<string, IRType>;
}

export function unwrapExpr(expr: IRExpression): IRExpression {
  if (expr.kind === "paren") return unwrapExpr(expr.inner);
  if (expr.kind === "nullish") return unwrapExpr(expr.left);
  return expr;
}

/**
 * The state variable a storage path is rooted at: `this.x`, then any chain of
 * `[k]`, `.get(k)` and `.field` on it (`this.proposals.get(id).meta.votes`),
 * or the same chain rooted at a local that aliases storage. `indexed` says
 * whether anything was applied to the root. Undefined for anything that is
 * not a storage path, including a call to one of the contract's own methods.
 */
export function storageRoot(expr: IRExpression, env: TypeEnv): { type: IRType; indexed: boolean } | undefined {
  const e = unwrapExpr(expr);
  if (e.kind === "member" && e.object.kind === "this") {
    const t = env.stateVarTypes?.get(e.property);
    return t ? { type: t, indexed: false } : undefined;
  }
  if (e.kind === "identifier") {
    const t = env.storageLocals?.has(e.name) ? env.localTypes?.get(e.name) : undefined;
    return t ? { type: t, indexed: false } : undefined;
  }
  if (e.kind === "conditional") {
    // `cond ? proposals[a] : proposals[b]` is a storage pointer in Solidity too.
    const a = storageRoot(e.consequent, env);
    const b = storageRoot(e.alternate, env);
    return a && b ? { type: a.type, indexed: true } : undefined;
  }
  let inner: IRExpression | undefined;
  if (e.kind === "index" || e.kind === "member") inner = e.object;
  else if (e.kind === "call" && e.callee.kind === "member" && e.callee.property === "get" && e.args.length === 1) inner = e.callee.object;
  if (!inner) return undefined;
  const root = storageRoot(inner, env);
  return root ? { type: root.type, indexed: true } : undefined;
}

export function isStorageAccess(expr: IRExpression, env: TypeEnv): boolean {
  return storageRoot(expr, env) !== undefined;
}

/**
 * A ternary yielding a struct, array or mapping from one storage branch and one
 * memory branch. No local can bind it faithfully: a `storage` local cannot hold
 * the memory side, a `memory` local would drop writes meant for the storage
 * side. `inferType` refuses to type it and the `storage-alias` rule reports it.
 */
export function mixesStorageAndMemory(expr: IRExpression, env: TypeEnv): boolean {
  const e = unwrapExpr(expr);
  if (e.kind !== "conditional") return false;
  const type = inferType(e.consequent, env) ?? inferType(e.alternate, env);
  return isReferenceType(type) && isStorageAccess(e.consequent, env) !== isStorageAccess(e.alternate, env);
}

const UINT256: IRType = { kind: "primitive", name: "uint256" };

/** Element type of a container: the value of a mapping, the element of an array. */
function elementOf(type: IRType | undefined): IRType | undefined {
  if (type?.kind === "mapping") return type.value;
  if (type?.kind === "array") return type.element;
  return undefined;
}

/**
 * Best-effort static type of an expression: state variables, parameters and
 * typed locals, indexing and `Map.get` through either, struct fields, the
 * `msg`/`block` globals and literals. Returns undefined when unknown, which
 * callers must treat as "cannot lower safely" rather than guessing.
 */
export function inferType(expr: IRExpression, env: TypeEnv): IRType | undefined {
  const e = unwrapExpr(expr);
  switch (e.kind) {
    case "identifier":
      return env.localTypes?.get(e.name);
    case "member": {
      if (e.object.kind === "this") return env.stateVarTypes?.get(e.property);
      if (e.object.kind === "identifier" && e.object.name === "msg") {
        if (e.property === "sender") return { kind: "primitive", name: "address" };
        if (e.property === "value") return UINT256;
        if (e.property === "data") return { kind: "primitive", name: "bytes" };
      }
      if (e.object.kind === "identifier" && e.object.name === "block") {
        if (e.property === "coinbase") return { kind: "primitive", name: "address" };
        return UINT256;
      }
      const objType = inferType(e.object, env);
      if (objType?.kind === "struct") {
        const field = env.structs?.get(objType.name)?.fields.find((f) => f.name === e.property);
        if (field) return field.type; // a struct may legitimately have a field called `length`
      }
      if (e.property === "length") return UINT256;
      return undefined;
    }
    case "index":
      return elementOf(inferType(e.object, env));
    case "call": {
      // `m.get(k)` is a mapping read; everything else needs a signature we do not track.
      if (e.callee.kind === "member" && e.callee.property === "get" && e.args.length === 1) {
        return elementOf(inferType(e.callee.object, env));
      }
      // A call to one of the contract's own functions: `this.draft(id)`, and
      // the bare form the emitter rewrites it to.
      const own = e.callee.kind === "member" && e.callee.object.kind === "this" ? e.callee.property
        : e.callee.kind === "identifier" ? e.callee.name : undefined;
      return own ? env.fnReturnTypes?.get(own) : undefined;
    }
    case "conditional":
      if (mixesStorageAndMemory(e, env)) return undefined;
      return inferType(e.consequent, env) ?? inferType(e.alternate, env);
    case "object":
      // `{ … } as Proposal`, once resolveStructLiterals has named it.
      return e.structName ? { kind: "struct", name: e.structName } : undefined;
    case "literal":
      if (e.literalType === "boolean") return { kind: "primitive", name: "bool" };
      if (e.literalType === "string") return { kind: "primitive", name: "string" };
      return UINT256;
    default:
      return undefined;
  }
}

const LOW_LEVEL_CALLS = new Set(["call", "delegatecall", "staticcall"]);

export function isLowLevelCall(expr: IRExpression): boolean {
  const e = unwrapExpr(expr);
  return e.kind === "call" && e.callee.kind === "member" && LOW_LEVEL_CALLS.has(e.callee.property);
}

/**
 * Component types of a destructuring declaration: the tuple annotation when
 * given, else `(bool, bytes memory)` for a low-level call, else `uint256` per
 * slot. The last case cannot be right in general, which is why
 * `destructure-shape` reports it as an error.
 */
export function destructureTypes(stmt: Extract<IRStatement, { kind: "destructure" }>): IRType[] {
  if (stmt.types && stmt.types.length > 0) {
    const out = [...stmt.types];
    while (out.length < stmt.names.length) out.push({ kind: "primitive", name: "uint256" });
    return out;
  }
  if (isLowLevelCall(stmt.init)) {
    return [{ kind: "primitive", name: "bool" }, { kind: "primitive", name: "bytes" }];
  }
  return stmt.names.map(() => ({ kind: "primitive", name: "uint256" } as IRType));
}

/** Solidity holds these by reference: a local bound to a storage path of one is a pointer, not a copy. */
export function isReferenceType(type: IRType | undefined): boolean {
  return type?.kind === "struct" || type?.kind === "array" || type?.kind === "mapping";
}

type LetStatement = Extract<IRStatement, { kind: "let" }>;

/**
 * What a `let` declares: its annotated type, else the inferred type of its
 * initializer; and whether it aliases storage. `const m = this.proposals.get(id).meta`
 * must be `Meta storage m`, or `m.votes = …` would write to a memory copy and
 * be lost. The emitter and `declareLocal` both go through here so they
 * cannot disagree about a local.
 */
export function localDeclaration(stmt: LetStatement, env: TypeEnv): { type?: IRType; storageRef: boolean } {
  const type = stmt.type ?? (stmt.init ? inferType(stmt.init, env) : undefined);
  const storageRef = isReferenceType(type) && stmt.init !== undefined && isStorageAccess(stmt.init, env);
  return { type, storageRef };
}

/** A `TypeEnv` whose local maps are guaranteed present, so declarations can be added in place. */
export interface Scope extends TypeEnv {
  localTypes: Map<string, IRType>;
  storageLocals: Set<string>;
}

/**
 * A child scope of `env`: the same state variables and structs, with copies
 * of the local maps, so what a block declares does not leak into a sibling
 * block. `const p = this.items[i]` in one branch of an `if` must not make the
 * `p` in the other branch a storage pointer.
 */
export function enterScope<T extends TypeEnv>(env: T): T & Scope {
  return { ...env, localTypes: new Map(env.localTypes), storageLocals: new Set(env.storageLocals) };
}

/**
 * Add what `stmt` declares to `scope`, in place. Call it after the statement
 * has been visited or emitted: an initializer is evaluated in the scope before
 * its own declaration. A `let` whose type is unknown still shadows an outer
 * local of the same name.
 */
export function declareLocal(stmt: IRStatement, scope: Scope): void {
  if (stmt.kind === "let") {
    const { type, storageRef } = localDeclaration(stmt, scope);
    if (type) scope.localTypes.set(stmt.name, type);
    else scope.localTypes.delete(stmt.name);
    if (storageRef) scope.storageLocals.add(stmt.name);
    else scope.storageLocals.delete(stmt.name);
  }
  if (stmt.kind === "destructure") {
    const types = destructureTypes(stmt);
    stmt.names.forEach((n, i) => {
      if (!n) return;
      if (types[i]) scope.localTypes.set(n, types[i]!);
      scope.storageLocals.delete(n);
    });
  }
}

/**
 * Pre-order walk with block scoping. `visit(stmt, scope)` sees the parameters
 * and every local declared before `stmt` in its own block or an enclosing one,
 * and nothing from a sibling block. A `for` initializer is scoped to the loop
 * and visited as a statement of its own, before the `for` itself. The emitter
 * keeps scope the same way, so the two agree about every local.
 */
export function walkScoped(stmts: IRStatement[], env: TypeEnv, visit: (stmt: IRStatement, scope: Scope) => void): void {
  const scope = enterScope(env);
  for (const s of stmts) {
    if (s.kind === "for") {
      const loop = enterScope(scope);
      if (s.init) {
        visit(s.init, loop);
        declareLocal(s.init, loop);
      }
      visit(s, loop);
      walkScoped(s.body, loop, visit);
      continue;
    }
    visit(s, scope);
    if (s.kind === "if") {
      walkScoped(s.then, scope, visit);
      if (s.else) walkScoped(s.else, scope, visit);
    }
    if (s.kind === "while" || s.kind === "block" || s.kind === "unchecked") walkScoped(s.body, scope, visit);
    declareLocal(s, scope);
  }
}

/**
 * The scope at the top of a function: `env` plus its parameters (a `storage`
 * parameter is a storage pointer). Locals are added per block by `walkScoped`
 * -- or by the emitter as it goes -- not here, since a flat, function-wide
 * map lets a same-named local in one branch of an `if` decide the type of the
 * one in the other.
 */
export function functionScope<T extends TypeEnv>(env: T, fn: IRFunction): T & Scope {
  return {
    ...env,
    localTypes: new Map(fn.params.map((p) => [p.name, p.type])),
    storageLocals: new Set(fn.params.filter((p) => p.location === "storage").map((p) => p.name)),
  };
}

export function typeEnvFor(contract: IRContract, fn: IRFunction): Scope {
  return functionScope(contractTypeEnv(contract), fn);
}

/** The part of a type environment that does not depend on which function is being looked at. */
export function contractTypeEnv(contract: IRContract): TypeEnv {
  return {
    stateVarTypes: new Map(contract.stateVars.map((v) => [v.name, v.type])),
    structs: new Map(contract.structs.map((s) => [s.name, s])),
    fnReturnTypes: new Map(contract.functions.filter((f) => !f.isConstructor).map((f) => [f.name, f.returnType])),
  };
}

/**
 * Every parameter and local of a function in one flat map, last declaration
 * of a name winning. Convenient for tooling; not what the emitter or the
 * validator use, because it cannot tell two same-named locals apart.
 */
export function collectLocalTypes(fn: IRFunction, env: TypeEnv = {}): Map<string, IRType> {
  const all = new Map<string, IRType>(fn.params.map((p) => [p.name, p.type]));
  walkScoped(fn.body, env, (stmt, scope) => {
    if (stmt.kind !== "let" && stmt.kind !== "destructure") return;
    const declared = enterScope(scope);
    declareLocal(stmt, declared);
    const names = stmt.kind === "let" ? [stmt.name] : stmt.names.filter((n): n is string => !!n);
    for (const n of names) {
      const t = declared.localTypes.get(n);
      if (t) all.set(n, t);
    }
  });
  return all;
}

/** The literal a TS `?? fallback` is redundant against: Solidity's default value for the type. */
export function isZeroLiteral(expr: IRExpression): boolean {
  const e = unwrapExpr(expr);
  if (e.kind === "literal") {
    if (e.literalType === "boolean") return e.value === "false";
    if (e.literalType === "string") return e.value === "";
    return /^0+$/.test(e.value);
  }
  // address(0)
  return e.kind === "call" && e.callee.kind === "identifier" && e.callee.name === "address" &&
    e.args.length === 1 && e.args[0]!.kind === "literal" && e.args[0]!.value === "0";
}

/** Solidity's explicit conversions: `address(x)`, `uint256(x)`, `bytes32(x)`… -- pure, so safe to evaluate twice. */
const TYPE_CONVERSION = /^(address|bool|string|bytes\d*|u?int\d*)$/;

/**
 * Whether evaluating the expression twice can differ from evaluating it once:
 * it contains an assignment, `++` / `--` / `delete`, `new`, or a call that is
 * not a mapping read (`m.get(k)`, `m.has(k)`) or a type conversion. `a ?? b`
 * lowers to a test that reads `a` twice, so such an `a` cannot be lowered
 * faithfully: `this.queue.get(this.pop()) ?? 1n` would pop twice.
 */
export function hasSideEffects(expr: IRExpression): boolean {
  return exprContains(expr, (e) => {
    if (e.kind === "assign" || e.kind === "new") return true;
    if (e.kind === "unary") return e.op === "++" || e.op === "--" || e.op === "delete";
    if (e.kind !== "call") return false;
    if (e.callee.kind === "member" && (e.callee.property === "get" || e.callee.property === "has") && e.args.length === 1) return false;
    if (e.callee.kind === "identifier" && TYPE_CONVERSION.test(e.callee.name)) return false;
    return true;
  });
}

/**
 * How to test "is at its default value" in Solidity for a type, as a template
 * with `$` standing for the expression. Undefined when the type has no cheap
 * emptiness test (structs, arrays, mappings, unknown).
 */
export function emptinessTest(type: IRType | undefined): string | undefined {
  if (!type) return undefined;
  // `CheckedAddress` is emitted as `address`; test it as one.
  if (type.kind === "custom") return emptinessTest(aliasedPrimitive(type.name));
  if (type.kind === "enum") return "uint8($) == 0";
  if (type.kind !== "primitive") return undefined;
  if (type.name === "bool") return "!$";
  if (type.name === "address") return "$ == address(0)";
  if (type.name === "string") return "bytes($).length == 0";
  if (type.name === "bytes") return "$.length == 0";
  if (type.name === "void") return undefined;
  return "$ == 0";
}

import type { IRContract, IRExpression, IRFunction, IRStatement, IRStructDecl, IRType } from "../ir/types";
import { walkStatements } from "../optimizer/walk";

/** Everything the emitter and validator know about identifier types at a given point. */
export interface TypeEnv {
  /** Declared type of each state variable. */
  stateVarTypes?: Map<string, IRType>;
  /** Parameters and typed locals of the function being emitted. */
  localTypes?: Map<string, IRType>;
  /** Structs declared alongside the contract, so field access can be typed. */
  structs?: Map<string, IRStructDecl>;
}

export function unwrapExpr(expr: IRExpression): IRExpression {
  if (expr.kind === "paren") return unwrapExpr(expr.inner);
  if (expr.kind === "nullish") return unwrapExpr(expr.left);
  return expr;
}

/** `this.<stateVar>`, `this.<stateVar>[k]`, or `this.<stateVar>.get(k)` -- a direct storage read. */
export function storageRoot(expr: IRExpression, env: TypeEnv): { type: IRType; indexed: boolean } | undefined {
  const e = unwrapExpr(expr);
  const stateVar = (m: IRExpression): IRType | undefined =>
    m.kind === "member" && m.object.kind === "this" ? env.stateVarTypes?.get(m.property) : undefined;
  const direct = stateVar(e);
  if (direct) return { type: direct, indexed: false };
  if (e.kind === "index") {
    const t = stateVar(e.object);
    if (t) return { type: t, indexed: true };
  }
  if (e.kind === "call" && e.callee.kind === "member" && e.callee.property === "get" && e.args.length === 1) {
    const t = stateVar(e.callee.object);
    if (t) return { type: t, indexed: true };
  }
  return undefined;
}

export function isStorageAccess(expr: IRExpression, env: TypeEnv): boolean {
  return storageRoot(expr, env) !== undefined;
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
    case "call":
      // `m.get(k)` is a mapping read; everything else needs a signature we do not track.
      if (e.callee.kind === "member" && e.callee.property === "get" && e.args.length === 1) {
        return elementOf(inferType(e.callee.object, env));
      }
      return undefined;
    case "conditional":
      return inferType(e.consequent, env) ?? inferType(e.alternate, env);
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

/**
 * Types of a function's parameters and of every local whose type is known:
 * annotated `let`/`const`, and destructured names. The emitter and the
 * validator must agree on this, or one reports an error the other does not make.
 */
export function collectLocalTypes(fn: IRFunction): Map<string, IRType> {
  const localTypes = new Map<string, IRType>();
  for (const p of fn.params) localTypes.set(p.name, p.type);
  walkStatements(fn.body, (s) => {
    if (s.kind === "let" && s.type) localTypes.set(s.name, s.type);
    if (s.kind === "destructure") {
      const types = destructureTypes(s);
      s.names.forEach((n, i) => { if (n && types[i]) localTypes.set(n, types[i]!); });
    }
  });
  return localTypes;
}

export function typeEnvFor(contract: IRContract, fn: IRFunction): TypeEnv {
  return {
    stateVarTypes: new Map(contract.stateVars.map((v) => [v.name, v.type])),
    structs: new Map(contract.structs.map((s) => [s.name, s])),
    localTypes: collectLocalTypes(fn),
  };
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

/**
 * How to test "is at its default value" in Solidity for a type, as a template
 * with `$` standing for the expression. Undefined when the type has no cheap
 * emptiness test (structs, arrays, mappings, unknown).
 */
export function emptinessTest(type: IRType | undefined): string | undefined {
  if (!type) return undefined;
  if (type.kind === "enum") return "uint8($) == 0";
  if (type.kind !== "primitive") return undefined;
  if (type.name === "bool") return "!$";
  if (type.name === "address") return "$ == address(0)";
  if (type.name === "string") return "bytes($).length == 0";
  if (type.name === "bytes") return "$.length == 0";
  if (type.name === "void") return undefined;
  return "$ == 0";
}

import type { IRExpression, IRType } from "../ir/types";

/** Everything the emitter and validator know about identifier types at a given point. */
export interface TypeEnv {
  /** Declared type of each state variable. */
  stateVarTypes?: Map<string, IRType>;
  /** Parameters and typed locals of the function being emitted. */
  localTypes?: Map<string, IRType>;
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

/**
 * Best-effort static type of an expression: storage reads, params/typed
 * locals, `msg.sender`, literals. Returns undefined when unknown.
 */
export function inferType(expr: IRExpression, env: TypeEnv): IRType | undefined {
  const e = unwrapExpr(expr);
  const root = storageRoot(e, env);
  if (root) {
    if (!root.indexed) return root.type;
    if (root.type.kind === "mapping") return root.type.value;
    if (root.type.kind === "array") return root.type.element;
    return undefined;
  }
  if (e.kind === "identifier") return env.localTypes?.get(e.name);
  if (e.kind === "member" && e.object.kind === "identifier" && e.object.name === "msg" && e.property === "sender") {
    return { kind: "primitive", name: "address" };
  }
  if (e.kind === "literal") {
    if (e.literalType === "boolean") return { kind: "primitive", name: "bool" };
    if (e.literalType === "string") return { kind: "primitive", name: "string" };
    return { kind: "primitive", name: "uint256" };
  }
  return undefined;
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
  if (type.name === "string" || type.name === "bytes") return "bytes($).length == 0";
  if (type.name === "void") return undefined;
  return "$ == 0";
}

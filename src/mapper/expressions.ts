import type { IRExpression } from "../ir/types";
import { emptinessTest, inferType, isZeroLiteral, type TypeEnv } from "./infer";


/**
 * Every binary operator the emitter can lower. An operator absent from here
 * would be emitted verbatim (`a instanceof b`, `a >>> b`), so the parser checks
 * against this list rather than letting solc report it against generated code.
 */
const BINARY_OP_MAP: Record<string, string> = {
  "===": "==",
  "!==": "!=",
  "==": "==",
  "!=": "!=",
  "&&": "&&",
  "||": "||",
  "+": "+",
  "-": "-",
  "*": "*",
  "/": "/",
  "%": "%",
  "**": "**",
  "<": "<",
  ">": ">",
  "<=": "<=",
  ">=": ">=",
  "&": "&",
  "|": "|",
  "^": "^",
  "<<": "<<",
  ">>": ">>",
};

export const SUPPORTED_BINARY_OPS: ReadonlySet<string> = new Set(Object.keys(BINARY_OP_MAP));

/** Compound assignments the emitter passes through unchanged, plus plain `=`. */
export const SUPPORTED_ASSIGN_OPS: ReadonlySet<string> = new Set([
  "=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=", "**=",
]);

const GLOBAL_OBJECT_REWRITES: Record<string, true> = {
  msg: true,
  block: true,
  tx: true,
};

export interface EmitContext extends TypeEnv {
  stateVarNames: Set<string>;
}

export function emitExpression(expr: IRExpression, ctx: EmitContext): string {
  return emit(expr, ctx);
}

function emit(expr: IRExpression, ctx: EmitContext): string {
  switch (expr.kind) {
    case "literal":
      return emitLiteral(expr);
    case "identifier":
      return expr.name;
    case "this":
      return "this";
    case "super":
      return "super";
    case "paren":
      return isAtomic(expr.inner) ? emit(expr.inner, ctx) : `(${emit(expr.inner, ctx)})`;
    case "member":
      return emitMember(expr, ctx);
    case "index":
      return `${emit(expr.object, ctx)}[${emit(expr.index, ctx)}]`;
    case "call":
      return emitCall(expr, ctx);
    case "new":
      return `new ${expr.className}(${expr.args.map((a) => emit(a, ctx)).join(", ")})`;
    case "binary":
      return emitBinary(expr, ctx);
    case "unary": {
      const needsParens = expr.operand.kind === "binary" || expr.operand.kind === "conditional" || expr.operand.kind === "assign";
      const inner = needsParens ? `(${emit(expr.operand, ctx)})` : emit(expr.operand, ctx);
      // `delete` is a word, not a symbol: `deletex` is not Solidity.
      const sep = /^[a-z]+$/.test(expr.op) ? " " : "";
      return expr.prefix ? `${expr.op}${sep}${inner}` : `${inner}${sep}${expr.op}`;
    }
    case "conditional":
      return `${emit(expr.test, ctx)} ? ${emit(expr.consequent, ctx)} : ${emit(expr.alternate, ctx)}`;
    case "nullish":
      return emitNullish(expr, ctx);
    case "assign":
      return emitAssign(expr, ctx);
    case "templateString":
      return emitTemplate(expr, ctx);
    case "object": {
      const fields = expr.properties.map((p) => `${p.name}: ${emit(p.value, ctx)}`).join(", ");
      return `${expr.structName ?? ""}({${fields}})`;
    }
    case "raw":
      return expr.text;
  }
}

/**
 * `a ?? b`. A mapping read never yields "undefined" in Solidity, it yields the
 * type's default, so `?? 0n` (or `?? false`, `?? ""`, `?? address(0)`) is
 * exactly `a`. Any other fallback has to become an explicit test, or the
 * program silently changes meaning. Types the emitter cannot test for
 * emptiness fall back to `a`; the `nullish-fallback` validator rule reports those.
 */
function emitNullish(expr: Extract<IRExpression, { kind: "nullish" }>, ctx: EmitContext): string {
  const left = emit(expr.left, ctx);
  if (isZeroLiteral(expr.right)) return left;
  const test = emptinessTest(inferType(expr.left, ctx));
  if (!test) return left;
  const leftAtom = isAtomic(expr.left) ? left : `(${left})`;
  return `(${test.replace("$", leftAtom)} ? ${emit(expr.right, ctx)} : ${leftAtom})`;
}

const EQUALITY_OPS = new Set(["==", "!=", "===", "!=="]);

/**
 * `s += x` on a `string` or `bytes` has no Solidity form either: `+=` is not
 * defined for them any more than `+` is. It becomes an assignment of the
 * concatenation. The left side is emitted twice, which is a read, never a call:
 * an assignment target with side effects is not valid TypeScript.
 */
function emitAssign(expr: Extract<IRExpression, { kind: "assign" }>, ctx: EmitContext): string {
  const left = emit(expr.left, ctx);
  const right = emit(expr.right, ctx);
  if (expr.op === "+=") {
    const t = inferType(expr.left, ctx);
    if (t?.kind === "primitive" && (t.name === "string" || t.name === "bytes")) {
      return `${left} = ${t.name}.concat(${left}, ${right})`;
    }
  }
  return `${left} ${expr.op} ${right}`;
}

/** `string` or `bytes` on either side, which Solidity's operators do not accept. */
function dynamicBytesKind(expr: Extract<IRExpression, { kind: "binary" }>, ctx: EmitContext): "string" | "bytes" | undefined {
  for (const side of [expr.left, expr.right]) {
    const t = inferType(side, ctx);
    if (t?.kind === "primitive" && (t.name === "string" || t.name === "bytes")) return t.name;
  }
  return undefined;
}

/**
 * Solidity has no `==` and no `+` for `string` or `bytes`: `a === b` emitted
 * `a == b` and `a + b` emitted `a + b`, neither of which compiles. Comparison
 * lowers to a hash comparison and concatenation to `string.concat` /
 * `bytes.concat`. Everything else is the plain operator.
 */
function emitBinary(expr: Extract<IRExpression, { kind: "binary" }>, ctx: EmitContext): string {
  const op = BINARY_OP_MAP[expr.op] ?? expr.op;
  const left = emit(expr.left, ctx);
  const right = emit(expr.right, ctx);
  const kind = dynamicBytesKind(expr, ctx);
  if (kind) {
    const hash = (v: string) => (kind === "string" ? `keccak256(bytes(${v}))` : `keccak256(${v})`);
    if (EQUALITY_OPS.has(expr.op)) return `${hash(left)} ${op} ${hash(right)}`;
    if (expr.op === "+") return `${kind}.concat(${left}, ${right})`;
  }
  return `${left} ${op} ${right}`;
}

function isAtomic(expr: IRExpression): boolean {
  switch (expr.kind) {
    case "literal":
    case "identifier":
    case "this":
    case "super":
    case "member":
    case "index":
    case "call":
    case "new":
    case "object":
      return true;
    case "paren":
      return isAtomic(expr.inner);
    case "nullish":
      return isAtomic(expr.left);
    default:
      return false;
  }
}

function emitLiteral(expr: Extract<IRExpression, { kind: "literal" }>): string {
  if (expr.literalType === "bigint") return expr.value;
  if (expr.literalType === "string") return JSON.stringify(expr.value);
  if (expr.literalType === "boolean") return expr.value;
  return expr.value;
}

function emitMember(expr: Extract<IRExpression, { kind: "member" }>, ctx: EmitContext): string {
  // `s.length` is valid TS for a string but not Solidity, which needs bytes(s).length.
  if (expr.property === "length") {
    const t = inferType(expr.object, ctx);
    if (t?.kind === "primitive" && t.name === "string") return `bytes(${emit(expr.object, ctx)}).length`;
  }
  if (expr.object.kind === "this" && ctx.stateVarNames.has(expr.property)) {
    return expr.property;
  }
  if (expr.object.kind === "this") {
    return expr.property;
  }
  if (expr.object.kind === "identifier" && GLOBAL_OBJECT_REWRITES[expr.object.name]) {
    return `${expr.object.name}.${expr.property}`;
  }
  return `${emit(expr.object, ctx)}.${expr.property}`;
}

function emitCall(expr: Extract<IRExpression, { kind: "call" }>, ctx: EmitContext): string {
  if (expr.callee.kind === "identifier" && expr.callee.name === "validate" && expr.args.length === 1) {
    const arg = emit(expr.args[0]!, ctx);
    return `_validateAddr(${arg})`;
  }
  if (expr.callee.kind === "identifier" && expr.callee.name === "pullPayment" && expr.args.length === 2) {
    return `_pullPayment(${emit(expr.args[0]!, ctx)}, ${emit(expr.args[1]!, ctx)})`;
  }
  if (expr.callee.kind === "member") {
    const member = expr.callee;
    if (member.property === "set" && expr.args.length === 2) {
      return `${emit(member.object, ctx)}[${emit(expr.args[0]!, ctx)}] = ${emit(expr.args[1]!, ctx)}`;
    }
    if (member.property === "get" && expr.args.length === 1) {
      return `${emit(member.object, ctx)}[${emit(expr.args[0]!, ctx)}]`;
    }
    if (member.property === "has" && expr.args.length === 1) {
      return `${emit(member.object, ctx)}[${emit(expr.args[0]!, ctx)}] != 0`;
    }
    if (member.property === "delete" && expr.args.length === 1) {
      return `delete ${emit(member.object, ctx)}[${emit(expr.args[0]!, ctx)}]`;
    }
  }
  if (expr.callee.kind === "identifier" && expr.callee.name === "require") {
    if (expr.args.length === 1) return `require(${emit(expr.args[0]!, ctx)})`;
    if (expr.args.length === 2) return `require(${emit(expr.args[0]!, ctx)}, ${emit(expr.args[1]!, ctx)})`;
  }
  if (expr.callee.kind === "identifier" && expr.callee.name === "revert") {
    if (expr.args.length === 0) return "revert()";
    return `revert(${expr.args.map((a) => emit(a, ctx)).join(", ")})`;
  }
  return `${emit(expr.callee, ctx)}(${expr.args.map((a) => emit(a, ctx)).join(", ")})`;
}

function emitTemplate(expr: Extract<IRExpression, { kind: "templateString" }>, ctx: EmitContext): string {
  if (expr.tag === "solidity") {
    let result = expr.quasis[0] ?? "";
    for (let i = 0; i < expr.expressions.length; i++) {
      result += emit(expr.expressions[i]!, ctx) + (expr.quasis[i + 1] ?? "");
    }
    return result;
  }
  const parts: string[] = [];
  for (let i = 0; i < expr.quasis.length; i++) {
    if (i > 0 && expr.expressions[i - 1]) {
      parts.push(emit(expr.expressions[i - 1]!, ctx));
    }
    if (expr.quasis[i]) parts.push(JSON.stringify(expr.quasis[i]));
  }
  return parts.filter(Boolean).join(" + ");
}

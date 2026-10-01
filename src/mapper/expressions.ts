import type { IRExpression, IRType } from "../ir/types";
import { emptinessTest, inferType, isZeroLiteral, type TypeEnv } from "./infer";
import { sameType, solidityType } from "./types";


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

/**
 * Compound assignments the emitter can lower, plus plain `=`. All pass
 * through unchanged except `**=`, which Solidity does not have: it becomes
 * `x = x ** y`.
 */
export const SUPPORTED_ASSIGN_OPS: ReadonlySet<string> = new Set([
  "=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=", "**=",
]);

/**
 * Solidity's ether and time units. `1n * ether` reads as `1 ether`, and a
 * bare `days` as `1 days`: in Solidity a unit is a literal suffix, never a
 * value of its own. None can be a Solidity identifier, so there is no local
 * or state variable they could be confused with.
 */
const UNITS = new Set(["wei", "gwei", "ether", "seconds", "minutes", "hours", "days", "weeks"]);

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
      // `_` is a modifier's placeholder statement and emits as itself.
      return UNITS.has(expr.name) && !ctx.localTypes?.has(expr.name) ? `1 ${expr.name}` : expr.name;
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
    case "new": {
      // `new Array<T>(n)` → `new T[](n)`.
      const target = expr.type ? solidityType(expr.type) : expr.className;
      return `new ${target}${emitOptions(expr.options, ctx)}(${expr.args.map((a) => emit(a, ctx)).join(", ")})`;
    }
    case "tuple":
      return `(${expr.elements.map((e) => (e ? emit(e, ctx) : "")).join(", ")})`;
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
  // Solidity has no `**=`.
  if (expr.op === "**=") return `${left} = ${left} ** ${isAtomic(expr.right) ? right : `(${right})`}`;
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
  // `2n * ether` → `2 ether`: a unit is a suffix on a number literal.
  if (expr.op === "*") {
    const unit = (e: IRExpression) => e.kind === "identifier" && UNITS.has(e.name) && !ctx.localTypes?.has(e.name) ? e.name : undefined;
    const lit = (e: IRExpression) => e.kind === "literal" && (e.literalType === "bigint" || e.literalType === "number");
    if (lit(expr.left) && unit(expr.right)) return `${left} ${unit(expr.right)}`;
    if (lit(expr.right) && unit(expr.left)) return `${right} ${unit(expr.left)}`;
  }
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
    case "tuple":
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
  // `this.address` is the contract's own address. Inherited state is typed
  // through `stateVarTypes`, so a base's variable named `address` -- which
  // Solidity would reject anyway -- is not mistaken for it.
  if (expr.object.kind === "this" && expr.property === "address" && !ctx.stateVarTypes?.has("address")) {
    return "address(this)";
  }
  if (expr.object.kind === "this") {
    return expr.property;
  }
  if (expr.object.kind === "identifier" && GLOBAL_OBJECT_REWRITES[expr.object.name]) {
    return `${expr.object.name}.${expr.property}`;
  }
  return `${emit(expr.object, ctx)}.${expr.property}`;
}

/** A call-options block: `{value: v, gas: g}`, or nothing. */
function emitOptions(options: Array<{ name: string; value: IRExpression }> | undefined, ctx: EmitContext): string {
  if (!options || options.length === 0) return "";
  return `{${options.map((o) => `${o.name}: ${emit(o.value, ctx)}`).join(", ")}}`;
}

/**
 * `x as Uint8` and `BigInt(x)`: a conversion Solidity needs only when the
 * operand's type is known and different. An unknown type is left alone --
 * adding a conversion on a guess can turn a compile error into a silent
 * truncation.
 */
function emitConversion(target: IRType, name: string, arg: IRExpression, ctx: EmitContext): string {
  const from = inferType(arg, ctx);
  if (!from || sameType(from, target)) return emit(arg, ctx);
  // `(a + b) as Uint64` is `uint64(a + b)`: the conversion's own parentheses suffice.
  return `${name}(${emit(arg.kind === "paren" ? arg.inner : arg, ctx)})`;
}

function emitCall(expr: Extract<IRExpression, { kind: "call" }>, ctx: EmitContext): string {
  if (expr.cast && expr.typeArgs?.[0] && expr.callee.kind === "identifier" && expr.args.length === 1) {
    return emitConversion(expr.typeArgs[0], expr.callee.name, expr.args[0]!, ctx);
  }
  if (expr.callee.kind === "identifier" && expr.callee.name === "BigInt" && expr.args.length === 1) {
    return emitConversion({ kind: "primitive", name: "uint256" }, "uint256", expr.args[0]!, ctx);
  }
  if (expr.callee.kind === "identifier" && expr.callee.name === "type" && expr.typeArgs?.length === 1 && expr.args.length === 0) {
    return `type(${solidityType(expr.typeArgs[0]!)})`;
  }
  // `abi.decode<[bigint, Address]>(data)` → `abi.decode(data, (uint256, address))`.
  if (expr.callee.kind === "member" && expr.callee.property === "decode" && expr.callee.object.kind === "identifier" &&
      expr.callee.object.name === "abi" && expr.typeArgs?.length === 1 && expr.args.length === 1) {
    const t = expr.typeArgs[0]!;
    const parts = t.kind === "tuple" ? t.elements : [t];
    return `abi.decode(${emit(expr.args[0]!, ctx)}, (${parts.map((p) => solidityType(p)).join(", ")}))`;
  }
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
  return `${emit(expr.callee, ctx)}${emitOptions(expr.options, ctx)}(${expr.args.map((a) => emit(a, ctx)).join(", ")})`;
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

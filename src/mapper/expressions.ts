import type { IRExpression, IRType } from "../ir/types";

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

const GLOBAL_OBJECT_REWRITES: Record<string, true> = {
  msg: true,
  block: true,
  tx: true,
};

export interface EmitContext {
  stateVarNames: Set<string>;
  /** Declared type of each state variable; lets locals bound to storage infer their type and location. */
  stateVarTypes?: Map<string, IRType>;
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
    case "binary": {
      const op = BINARY_OP_MAP[expr.op] ?? expr.op;
      return `${emit(expr.left, ctx)} ${op} ${emit(expr.right, ctx)}`;
    }
    case "unary": {
      const needsParens = expr.operand.kind === "binary" || expr.operand.kind === "conditional" || expr.operand.kind === "assign";
      const inner = needsParens ? `(${emit(expr.operand, ctx)})` : emit(expr.operand, ctx);
      return expr.prefix ? `${expr.op}${inner}` : `${inner}${expr.op}`;
    }
    case "conditional":
      return `${emit(expr.test, ctx)} ? ${emit(expr.consequent, ctx)} : ${emit(expr.alternate, ctx)}`;
    case "nullish":
      return emit(expr.left, ctx);
    case "assign":
      return `${emit(expr.left, ctx)} ${expr.op} ${emit(expr.right, ctx)}`;
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

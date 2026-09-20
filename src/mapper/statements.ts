import type { IRExpression, IRStatement, IRType } from "../ir/types";
import { needsLocationQualifier, solidityType } from "./types";
import { emitExpression, type EmitContext } from "./expressions";

export function emitStatements(stmts: IRStatement[], ctx: EmitContext, indent: string): string[] {
  const lines: string[] = [];
  for (const stmt of stmts) lines.push(...emitStatement(stmt, ctx, indent));
  return lines;
}

function emitStatement(stmt: IRStatement, ctx: EmitContext, indent: string): string[] {
  switch (stmt.kind) {
    case "expression":
      return [`${indent}${emitExpression(stmt.expr, ctx)};`];
    case "return":
      return [stmt.value
        ? `${indent}return ${emitExpression(stmt.value, ctx)};`
        : `${indent}return;`];
    case "if": {
      const lines: string[] = [];
      lines.push(`${indent}if (${emitExpression(stmt.test, ctx)}) {`);
      lines.push(...emitStatements(stmt.then, ctx, indent + "    "));
      if (stmt.else && stmt.else.length > 0) {
        lines.push(`${indent}} else {`);
        lines.push(...emitStatements(stmt.else, ctx, indent + "    "));
      }
      lines.push(`${indent}}`);
      return lines;
    }
    case "for": {
      const initStr = stmt.init ? emitForInit(stmt.init, ctx) : "";
      const testStr = stmt.test ? emitExpression(stmt.test, ctx) : "";
      const updateInner = stmt.update ? emitExpression(stmt.update, ctx) : "";
      const updateStr = stmt.uncheckedIncrement && updateInner ? "" : updateInner;
      const lines: string[] = [];
      lines.push(`${indent}for (${initStr}; ${testStr}; ${updateStr}) {`);
      lines.push(...emitStatements(stmt.body, ctx, indent + "    "));
      if (stmt.uncheckedIncrement && updateInner) {
        lines.push(`${indent}    unchecked { ${updateInner}; }`);
      }
      lines.push(`${indent}}`);
      return lines;
    }
    case "unchecked": {
      const lines: string[] = [];
      lines.push(`${indent}unchecked {`);
      lines.push(...emitStatements(stmt.body, ctx, indent + "    "));
      lines.push(`${indent}}`);
      return lines;
    }
    case "revert":
      return [`${indent}revert ${stmt.errorName}(${stmt.args.map((a) => emitExpression(a, ctx)).join(", ")});`];
    case "emit":
      return [`${indent}emit ${stmt.eventName}(${stmt.args.map((a) => emitExpression(a, ctx)).join(", ")});`];
    case "while": {
      const lines: string[] = [];
      lines.push(`${indent}while (${emitExpression(stmt.test, ctx)}) {`);
      lines.push(...emitStatements(stmt.body, ctx, indent + "    "));
      lines.push(`${indent}}`);
      return lines;
    }
    case "block": {
      const lines: string[] = [];
      lines.push(`${indent}{`);
      lines.push(...emitStatements(stmt.body, ctx, indent + "    "));
      lines.push(`${indent}}`);
      return lines;
    }
    case "let": {
      const type = stmt.type ?? (stmt.init ? inferTypeFromStorage(stmt.init, ctx) ?? inferStructType(stmt.init, ctx) : undefined);
      // A struct local bound directly to a storage slot is a reference, not a copy:
      // `const p = this.proposals.get(id)` must become `Proposal storage p = proposals[id];`
      // or writes through `p` would silently go to a memory copy.
      const storageRef = type?.kind === "struct" && stmt.init !== undefined && isStorageAccess(stmt.init, ctx);
      // solidityType's "storage" location yields the bare declaration form; a local needs the keyword spelled out.
      const typeStr = !type ? "uint256" : storageRef ? `${solidityType(type, "storage")} storage` : solidityType(type, "memory");
      const initStr = stmt.init ? ` = ${emitExpression(stmt.init, ctx)}` : "";
      return [`${indent}${typeStr} ${stmt.name}${initStr};`];
    }
    case "throw":
      return [`${indent}revert();`];
    case "raw":
      return [`${indent}${stmt.text}`];
  }
}

function unwrap(expr: IRExpression): IRExpression {
  if (expr.kind === "paren") return unwrap(expr.inner);
  if (expr.kind === "nullish") return unwrap(expr.left);
  return expr;
}

/** `this.<stateVar>`, `this.<stateVar>[k]`, or `this.<stateVar>.get(k)` -- a direct storage read. */
function storageRoot(expr: IRExpression, ctx: EmitContext): { type: IRType; indexed: boolean } | undefined {
  const e = unwrap(expr);
  const stateVar = (m: IRExpression): IRType | undefined =>
    m.kind === "member" && m.object.kind === "this" ? ctx.stateVarTypes?.get(m.property) : undefined;
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

function isStorageAccess(expr: IRExpression, ctx: EmitContext): boolean {
  return storageRoot(expr, ctx) !== undefined;
}

function inferTypeFromStorage(expr: IRExpression, ctx: EmitContext): IRType | undefined {
  const root = storageRoot(expr, ctx);
  if (!root) return undefined;
  if (!root.indexed) return root.type;
  if (root.type.kind === "mapping") return root.type.value;
  if (root.type.kind === "array") return root.type.element;
  return undefined;
}

/**
 * An untyped local holding a struct value: `const p = { … } as Proposal` or
 * `const p = this.draft(id)` where `draft` returns a struct. Without this the
 * `uint256` fallback below produces `uint256 p = Proposal({…})`.
 */
function inferStructType(expr: IRExpression, ctx: EmitContext): IRType | undefined {
  const e = unwrap(expr);
  if (e.kind === "object" && e.structName) return { kind: "struct", name: e.structName };
  if (e.kind === "call" && e.callee.kind === "member" && e.callee.object.kind === "this") {
    const ret = ctx.fnReturnTypes?.get(e.callee.property);
    if (ret?.kind === "struct") return ret;
  }
  return undefined;
}

function emitForInit(init: IRStatement, ctx: EmitContext): string {
  if (init.kind === "let") {
    const typeStr = init.type ? solidityType(init.type) : "uint256";
    const initStr = init.init ? ` = ${emitExpression(init.init, ctx)}` : "";
    return `${typeStr} ${init.name}${initStr}`;
  }
  if (init.kind === "expression") return emitExpression(init.expr, ctx);
  return "";
}

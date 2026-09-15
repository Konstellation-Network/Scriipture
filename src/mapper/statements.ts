import type { IRExpression, IRStatement, IRType } from "../ir/types";
import { solidityType } from "./types";
import { emitExpression, type EmitContext } from "./expressions";
import { inferType, isStorageAccess, unwrapExpr } from "./infer";

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
      const type = stmt.type ?? (stmt.init ? inferType(stmt.init, ctx) : undefined);
      // A struct local bound directly to a storage slot is a reference, not a copy:
      // `const p = this.proposals.get(id)` must become `Proposal storage p = proposals[id];`
      // or writes through `p` would silently go to a memory copy.
      const storageRef = type?.kind === "struct" && stmt.init !== undefined && isStorageAccess(stmt.init, ctx);
      // solidityType's "storage" location yields the bare declaration form; a local needs the keyword spelled out.
      const typeStr = !type ? "uint256" : storageRef ? `${solidityType(type, "storage")} storage` : solidityType(type, "memory");
      const initStr = stmt.init ? ` = ${emitExpression(stmt.init, ctx)}` : "";
      return [`${indent}${typeStr} ${stmt.name}${initStr};`];
    }
    case "destructure": {
      const types = destructureTypes(stmt, ctx);
      const parts = types.map((t, i) => {
        const name = stmt.names[i];
        return name ? `${solidityType(t, "memory")} ${name}` : "";
      });
      return [`${indent}(${parts.join(", ")}) = ${emitExpression(stmt.init, ctx)};`];
    }
    case "throw":
      return [`${indent}revert();`];
    case "raw":
      return [`${indent}${stmt.text}`];
  }
}

const LOW_LEVEL_CALLS = new Set(["call", "delegatecall", "staticcall"]);

/** `(bool, bytes memory)` for a low-level call, else the tuple annotation, else `uint256` per slot. */
export function destructureTypes(stmt: Extract<IRStatement, { kind: "destructure" }>, _ctx: EmitContext): IRType[] {
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

export function isLowLevelCall(expr: IRExpression): boolean {
  const e = unwrapExpr(expr);
  return e.kind === "call" && e.callee.kind === "member" && LOW_LEVEL_CALLS.has(e.callee.property);
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

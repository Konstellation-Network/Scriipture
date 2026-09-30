import type { IRStatement } from "../ir/types";
import { solidityType } from "./types";
import { emitExpression, type EmitContext } from "./expressions";
import { declareLocal, destructureTypes, enterScope, localDeclaration } from "./infer";

/**
 * Emit a block. Each statement is emitted in the scope of the locals declared
 * before it in this block or an enclosing one -- the same scoping `walkScoped`
 * gives the validator -- so a `const p` in one branch of an `if` says nothing
 * about the `p` in the other.
 */
export function emitStatements(stmts: IRStatement[], ctx: EmitContext, indent: string): string[] {
  const scope = enterScope(ctx);
  const lines: string[] = [];
  for (const stmt of stmts) {
    lines.push(...emitStatement(stmt, scope, indent));
    declareLocal(stmt, scope);
  }
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
      // The initializer's local is scoped to the loop: visible to test, update and body, not after.
      const loop = enterScope(ctx);
      const initStr = stmt.init ? emitForInit(stmt.init, loop) : "";
      if (stmt.init) declareLocal(stmt.init, loop);
      const testStr = stmt.test ? emitExpression(stmt.test, loop) : "";
      const updateInner = stmt.update ? emitExpression(stmt.update, loop) : "";
      const updateStr = stmt.uncheckedIncrement && updateInner ? "" : updateInner;
      const lines: string[] = [];
      lines.push(`${indent}for (${initStr}; ${testStr}; ${updateStr}) {`);
      lines.push(...emitStatements(stmt.body, loop, indent + "    "));
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
      // A reference-typed local bound to a storage path is a pointer, not a copy:
      // `const p = this.proposals.get(id)` must become `Proposal storage p = proposals[id];`
      // or writes through `p` would silently go to a memory copy. `localDeclaration`
      // is also what builds the type environment, so the two cannot disagree.
      const { type, storageRef } = localDeclaration(stmt, ctx);
      // solidityType's "storage" location yields the bare declaration form; a local needs the keyword spelled out.
      const typeStr = !type ? "uint256" : storageRef ? `${solidityType(type, "storage")} storage` : solidityType(type, "memory");
      const initStr = stmt.init ? ` = ${emitExpression(stmt.init, ctx)}` : "";
      return [`${indent}${typeStr} ${stmt.name}${initStr};`];
    }
    case "destructure": {
      const types = destructureTypes(stmt);
      const parts = types.map((t, i) => {
        const name = stmt.names[i];
        return name ? `${solidityType(t, "memory")} ${name}` : "";
      });
      return [`${indent}(${parts.join(", ")}) = ${emitExpression(stmt.init, ctx)};`];
    }
    case "break":
      return [`${indent}break;`];
    case "continue":
      return [`${indent}continue;`];
    case "throw":
      return [`${indent}revert();`];
    case "raw":
      return [`${indent}${stmt.text}`];
  }
}


function emitForInit(init: IRStatement, ctx: EmitContext): string {
  if (init.kind === "let") {
    const { type } = localDeclaration(init, ctx);
    const typeStr = type ? solidityType(type) : "uint256";
    const initStr = init.init ? ` = ${emitExpression(init.init, ctx)}` : "";
    return `${typeStr} ${init.name}${initStr}`;
  }
  if (init.kind === "expression") return emitExpression(init.expr, ctx);
  return "";
}

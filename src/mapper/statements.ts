import type { IRStatement } from "../ir/types";
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
      const typeStr = stmt.type ? solidityType(stmt.type, needsLocationQualifier(stmt.type) ? "memory" : "memory") : "uint256";
      const initStr = stmt.init ? ` = ${emitExpression(stmt.init, ctx)}` : "";
      return [`${indent}${typeStr} ${stmt.name}${initStr};`];
    }
    case "throw":
      return [`${indent}revert();`];
    case "raw":
      return [`${indent}${stmt.text}`];
  }
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

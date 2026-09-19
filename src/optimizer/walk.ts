import type { IRExpression, IRStatement } from "../ir/types";

export function walkStatementArrays(stmts: IRStatement[], visit: (arr: IRStatement[]) => void): void {
  visit(stmts);
  for (const s of stmts) {
    if (s.kind === "if") {
      walkStatementArrays(s.then, visit);
      if (s.else) walkStatementArrays(s.else, visit);
    }
    if (s.kind === "for" || s.kind === "while" || s.kind === "block" || s.kind === "unchecked") {
      walkStatementArrays(s.body, visit);
    }
  }
}

/**
 * Pre-order walk of every statement, including a `for` initializer, which is
 * a statement of its own (`walkExpressionsInStatement` on the `for` covers
 * only its test and update, so nothing is visited twice).
 */
export function walkStatements(stmts: IRStatement[], visit: (s: IRStatement) => void): void {
  for (const s of stmts) {
    visit(s);
    if (s.kind === "if") {
      walkStatements(s.then, visit);
      if (s.else) walkStatements(s.else, visit);
    }
    if (s.kind === "for" && s.init) walkStatements([s.init], visit);
    if (s.kind === "for" || s.kind === "while" || s.kind === "block" || s.kind === "unchecked") {
      walkStatements(s.body, visit);
    }
  }
}

export function walkExpr(expr: IRExpression, visit: (e: IRExpression) => void): void {
  visit(expr);
  switch (expr.kind) {
    case "member": return walkExpr(expr.object, visit);
    case "index": walkExpr(expr.object, visit); walkExpr(expr.index, visit); return;
    case "call": walkExpr(expr.callee, visit); for (const a of expr.args) walkExpr(a, visit); return;
    case "new": for (const a of expr.args) walkExpr(a, visit); return;
    case "binary": walkExpr(expr.left, visit); walkExpr(expr.right, visit); return;
    case "unary": walkExpr(expr.operand, visit); return;
    case "conditional": walkExpr(expr.test, visit); walkExpr(expr.consequent, visit); walkExpr(expr.alternate, visit); return;
    case "nullish": walkExpr(expr.left, visit); walkExpr(expr.right, visit); return;
    case "assign": walkExpr(expr.left, visit); walkExpr(expr.right, visit); return;
    case "paren": walkExpr(expr.inner, visit); return;
    case "templateString": for (const e of expr.expressions) walkExpr(e, visit); return;
    case "object": for (const p of expr.properties) walkExpr(p.value, visit); return;
  }
}

export function walkExpressionsInStatement(stmt: IRStatement, visit: (e: IRExpression) => void): void {
  if (stmt.kind === "expression") walkExpr(stmt.expr, visit);
  if (stmt.kind === "return" && stmt.value) walkExpr(stmt.value, visit);
  if (stmt.kind === "if") walkExpr(stmt.test, visit);
  if (stmt.kind === "while") walkExpr(stmt.test, visit);
  if (stmt.kind === "for") {
    // `init` is visited as its own statement by walkStatements.
    if (stmt.test) walkExpr(stmt.test, visit);
    if (stmt.update) walkExpr(stmt.update, visit);
  }
  if (stmt.kind === "let" && stmt.init) walkExpr(stmt.init, visit);
  if (stmt.kind === "destructure") walkExpr(stmt.init, visit);
  if (stmt.kind === "revert" || stmt.kind === "emit") for (const a of stmt.args) walkExpr(a, visit);
  if (stmt.kind === "throw") walkExpr(stmt.argument, visit);
}

export function exprContains(haystack: IRExpression, predicate: (e: IRExpression) => boolean): boolean {
  let found = false;
  walkExpr(haystack, (e) => { if (predicate(e)) found = true; });
  return found;
}

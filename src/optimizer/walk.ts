import type { IRExpression, IRStatement } from "../ir/types";

export function walkStatementArrays(stmts: IRStatement[], visit: (arr: IRStatement[]) => void): void {
  visit(stmts);
  for (const s of stmts) {
    if (s.kind === "if") {
      walkStatementArrays(s.then, visit);
      if (s.else) walkStatementArrays(s.else, visit);
    }
    if (s.kind === "for" || s.kind === "while" || s.kind === "block" || s.kind === "unchecked" || s.kind === "try") {
      walkStatementArrays(s.body, visit);
    }
    if (s.kind === "try") for (const c of s.catches) walkStatementArrays(c.body, visit);
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
    if (s.kind === "for" || s.kind === "while" || s.kind === "block" || s.kind === "unchecked" || s.kind === "try") {
      walkStatements(s.body, visit);
    }
    if (s.kind === "try") for (const c of s.catches) walkStatements(c.body, visit);
  }
}

export function walkExpr(expr: IRExpression, visit: (e: IRExpression) => void): void {
  visit(expr);
  switch (expr.kind) {
    case "member": return walkExpr(expr.object, visit);
    case "index": walkExpr(expr.object, visit); walkExpr(expr.index, visit); return;
    case "call":
      walkExpr(expr.callee, visit);
      for (const o of expr.options ?? []) walkExpr(o.value, visit);
      for (const a of expr.args) walkExpr(a, visit);
      return;
    case "new":
      for (const o of expr.options ?? []) walkExpr(o.value, visit);
      for (const a of expr.args) walkExpr(a, visit);
      return;
    case "tuple": for (const e of expr.elements) if (e) walkExpr(e, visit); return;
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
  if (stmt.kind === "try") walkExpr(stmt.call, visit);
}

export function exprContains(haystack: IRExpression, predicate: (e: IRExpression) => boolean): boolean {
  let found = false;
  walkExpr(haystack, (e) => { if (predicate(e)) found = true; });
  return found;
}

/** The state variable an assignment target writes: `this.x`, `this.x[k]`, `this.x.f`, `this.x.get(k)`. */
function writtenStateVar(target: IRExpression): string | undefined {
  let e = target;
  for (;;) {
    if (e.kind === "paren") e = e.inner;
    else if (e.kind === "index" || (e.kind === "member" && e.object.kind !== "this")) e = e.object;
    else if (e.kind === "call" && e.callee.kind === "member" && e.callee.property === "get") e = e.callee.object;
    else break;
  }
  return e.kind === "member" && e.object.kind === "this" ? e.property : undefined;
}

/**
 * Every state variable `stmts` can write, by any route: `=` and the compound
 * assignments, `++` / `--` in any position (a `for` update included), `delete`,
 * either side of a tuple assignment, and the `Map` / array mutators. The
 * `constant` and `immutable` passes decide what is never written from this,
 * so it must err toward "written".
 */
export function stateWrites(stmts: IRStatement[]): Set<string> {
  const out = new Set<string>();
  const add = (target: IRExpression): void => {
    if (target.kind === "tuple") { for (const t of target.elements) if (t) add(t); return; }
    const name = writtenStateVar(target);
    if (name) out.add(name);
  };
  walkStatements(stmts, (s) => {
    walkExpressionsInStatement(s, (e) => {
      if (e.kind === "assign") add(e.left);
      if (e.kind === "unary" && (e.op === "++" || e.op === "--" || e.op === "delete")) add(e.operand);
      if (e.kind === "call" && e.callee.kind === "member" && ["set", "delete", "push", "pop"].includes(e.callee.property)) add(e.callee.object);
    });
  });
  return out;
}

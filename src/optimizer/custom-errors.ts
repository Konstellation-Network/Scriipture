import type { IRContract, IRErrorDecl, IRExpression, IRStatement } from "../ir/types";
import type { OptimizationChange } from "./passes";
import { walkStatementArrays } from "./walk";

export function customErrors(contract: IRContract): OptimizationChange[] {
  const changes: OptimizationChange[] = [];
  const errorByMsg = new Map<string, IRErrorDecl>();
  // Errors the user declared with @error. A synthesized name that collides with
  // one would emit a duplicate declaration, so those requires are left alone.
  const userDeclared = new Set(contract.errors.map((e) => e.name));

  for (const fn of contract.functions) {
    if (fn.isAssembly) continue;
    walkStatementArrays(fn.body, (arr) => {
      for (let i = 0; i < arr.length; i++) {
        const stmt = arr[i]!;
        if (stmt.kind !== "expression") continue;
        const expr = stmt.expr;
        if (expr.kind !== "call") continue;
        if (expr.callee.kind !== "identifier" || expr.callee.name !== "require") continue;
        if (expr.args.length !== 2) continue;
        const [condition, message] = expr.args;
        if (!message || message.kind !== "literal" || message.literalType !== "string") continue;

        const errorName = errorNameFromMessage(message.value);
        if (userDeclared.has(errorName)) continue;
        if (!errorByMsg.has(errorName)) {
          const decl: IRErrorDecl = { name: errorName, params: [] };
          errorByMsg.set(errorName, decl);
          contract.errors.push(decl);
        }

        let test: IRExpression;
        if (condition!.kind === "unary" && condition!.op === "!" && condition!.prefix) {
          test = condition!.operand;
        } else if (condition!.kind === "paren" && condition!.inner.kind === "unary" && condition!.inner.op === "!" && condition!.inner.prefix) {
          test = condition!.inner.operand;
        } else {
          test = { kind: "unary", op: "!", operand: condition!, prefix: true };
        }
        const newStmt: IRStatement = {
          kind: "if",
          test,
          then: [{ kind: "revert", errorName, args: [], loc: stmt.loc }],
          loc: stmt.loc,
        };
        arr[i] = newStmt;
        changes.push({
          pass: "custom-errors",
          detail: `require("${message.value}") → revert ${errorName}()`,
          applied: true,
        });
      }
    });
  }

  return changes;
}

function errorNameFromMessage(msg: string): string {
  const cleaned = msg.replace(/[^A-Za-z0-9 ]/g, " ").trim();
  if (!cleaned) return "RequireFailed";
  const camel = cleaned
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  return /^[0-9]/.test(camel) ? "E" + camel : camel;
}

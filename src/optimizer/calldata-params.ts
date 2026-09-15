import type { IRContract, IRExpression, IRParam } from "../ir/types";
import type { OptimizationChange } from "./passes";
import { walkExpressionsInStatement, walkStatements } from "./walk";

export function calldataParams(contract: IRContract): OptimizationChange[] {
  const changes: OptimizationChange[] = [];

  for (const fn of contract.functions) {
    if (fn.isConstructor) continue;
    if (fn.isAssembly) continue;

    const mutated = new Set<string>();
    walkStatements(fn.body, (stmt) => {
      walkExpressionsInStatement(stmt, (e: IRExpression) => {
        if (e.kind === "assign") {
          const root = rootIdentifier(e.left);
          if (root) mutated.add(root);
        }
        if (e.kind === "unary" && (e.op === "++" || e.op === "--")) {
          const root = rootIdentifier(e.operand);
          if (root) mutated.add(root);
        }
        if (e.kind === "call" && e.callee.kind === "member") {
          if (e.callee.object.kind === "identifier" &&
              (e.callee.property === "push" || e.callee.property === "pop")) {
            mutated.add(e.callee.object.name);
          }
        }
      });
    });

    for (const p of fn.params) {
      if (p.location) continue;
      if (!isCalldataCandidate(p)) continue;
      if (mutated.has(p.name)) continue;
      p.location = "calldata";
      changes.push({
        pass: "calldata-params",
        detail: `param "${p.name}" in ${fn.name} → calldata`,
        applied: true,
      });
    }
  }

  return changes;
}

/** `a`, `a[i]`, `a.b[i].c` → "a"; anything not rooted at a plain identifier → undefined. */
function rootIdentifier(e: IRExpression): string | undefined {
  if (e.kind === "identifier") return e.name;
  if (e.kind === "index") return rootIdentifier(e.object);
  if (e.kind === "member") return rootIdentifier(e.object);
  if (e.kind === "paren") return rootIdentifier(e.inner);
  return undefined;
}

function isCalldataCandidate(p: IRParam): boolean {
  if (p.type.kind === "array") return true;
  if (p.type.kind === "primitive" && (p.type.name === "string" || p.type.name === "bytes")) return true;
  return false;
}

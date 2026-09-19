import type { IRContract, IRExpression, IRParam } from "../ir/types";
import type { OptimizationChange } from "./passes";
import { resolveFunctionDecorators } from "../mapper/decorators";
import { walkExpressionsInStatement, walkStatements } from "./walk";

/**
 * Names of this contract's own functions that are called from inside it.
 * A `calldata` parameter cannot accept a memory value, a storage value or a
 * literal, so a function reached by an internal call must keep `memory` --
 * otherwise solc rejects the call site with "Invalid implicit conversion".
 */
function internallyCalledFunctions(contract: IRContract): Set<string> {
  const own = new Set(contract.functions.map((f) => f.name));
  const called = new Set<string>();
  for (const fn of contract.functions) {
    walkStatements(fn.body, (stmt) => {
      walkExpressionsInStatement(stmt, (e) => {
        if (e.kind !== "call") return;
        const callee = e.callee;
        // `this.helper(x)` and, defensively, a bare `helper(x)`.
        if (callee.kind === "member" && callee.object.kind === "this" && own.has(callee.property)) {
          called.add(callee.property);
        } else if (callee.kind === "identifier" && own.has(callee.name)) {
          called.add(callee.name);
        }
      });
    });
  }
  return called;
}

export function calldataParams(contract: IRContract): OptimizationChange[] {
  const changes: OptimizationChange[] = [];
  const internallyCalled = internallyCalledFunctions(contract);

  for (const fn of contract.functions) {
    if (fn.isConstructor) continue;
    if (fn.isAssembly) continue;

    // Only the outside world calls this function, so every argument arrives in calldata.
    const visibility = resolveFunctionDecorators(fn.decorators).visibility ?? "public";
    if (visibility === "internal" || visibility === "private") continue;
    if (internallyCalled.has(fn.name)) continue;

    const mutated = new Set<string>();
    walkStatements(fn.body, (stmt) => {
      walkExpressionsInStatement(stmt, (e: IRExpression) => {
        if (e.kind === "assign") {
          const root = rootIdentifier(e.left);
          if (root) mutated.add(root);
        }
        if (e.kind === "unary" && (e.op === "++" || e.op === "--" || e.op === "delete")) {
          const root = rootIdentifier(e.operand);
          if (root) mutated.add(root);
        }
        if (e.kind === "call" && e.callee.kind === "member") {
          // `p.push(x)` but also `p[i].push(x)` and `p[i].j.pop()`.
          if (e.callee.property === "push" || e.callee.property === "pop" || e.callee.property === "delete") {
            const root = rootIdentifier(e.callee.object);
            if (root) mutated.add(root);
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

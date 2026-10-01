import type { IRContract, IRExpression, IRFunction, IRParam } from "../ir/types";
import type { OptimizationChange } from "./passes";
import { resolveFunctionDecorators } from "../mapper/decorators";
import { inferType, isStorageAccess, localDeclaration, typeEnvFor, walkScoped } from "../mapper/infer";
import { needsLocationQualifier } from "../mapper/types";
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
  const mutated = mutatedParams(contract);

  for (const fn of contract.functions) {
    if (fn.isConstructor) continue;
    if (fn.isAssembly) continue;
    // A modifier's parameters cannot be calldata, and an abstract function's
    // locations must match whatever overrides it, which this pass cannot see.
    if (fn.special || fn.isAbstract) continue;

    // Only the outside world calls this function, so every argument arrives in calldata.
    const visibility = resolveFunctionDecorators(fn.decorators).visibility ?? "public";
    if (visibility === "internal" || visibility === "private") continue;
    if (internallyCalled.has(fn.name)) continue;

    const againstStorage = paramsBranchingAgainstStorage(contract, fn);

    for (const p of fn.params) {
      if (p.location) continue;
      if (!isCalldataCandidate(p)) continue;
      if (mutated.get(fn)?.has(p.name)) continue;
      if (againstStorage.has(p.name)) continue;
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

/**
 * Locals that alias a reference-typed parameter: `const v = values`,
 * `const r = recs[0]`, and chains of those. With a `memory` parameter such a
 * local is a reference and a write through it reaches the caller's value;
 * with `calldata` it would be a copy. So a write through an alias is a write
 * to the parameter. Function-wide and conservative: a name that aliases a
 * parameter anywhere counts everywhere, which can only keep `memory` where
 * `calldata` might have been legal, never the reverse.
 */
function paramAliases(contract: IRContract, fn: IRFunction): Map<string, string> {
  const params = new Set(fn.params.map((p) => p.name));
  const aliases = new Map<string, string>();
  walkScoped(fn.body, typeEnvFor(contract, fn), (stmt, scope) => {
    if (stmt.kind !== "let" || !stmt.init) return;
    const root = rootIdentifier(stmt.init);
    const param = root ? (params.has(root) ? root : aliases.get(root)) : undefined;
    if (!param) return;
    // A value-typed local (`const x = values[0]` of `bigint[]`) is a copy under any location.
    const { type } = localDeclaration(stmt, scope);
    if (type && !needsLocationQualifier(type)) return;
    aliases.set(stmt.name, param);
  });
  return aliases;
}

/**
 * Parameters written to in a function body -- `p = …`, `p[i] = …`, `p.f++`,
 * `delete p[i]`, `p[i].push(x)` -- directly or through a local alias.
 */
function directlyMutated(fn: IRFunction, aliases: Map<string, string>): Set<string> {
  const params = new Set(fn.params.map((p) => p.name));
  const asParam = (e: IRExpression): string | undefined => {
    const root = rootIdentifier(e);
    return root ? (params.has(root) ? root : aliases.get(root)) : undefined;
  };
  const out = new Set<string>();
  walkStatements(fn.body, (stmt) => {
    walkExpressionsInStatement(stmt, (e: IRExpression) => {
      let written: string | undefined;
      if (e.kind === "assign") written = asParam(e.left);
      if (e.kind === "unary" && (e.op === "++" || e.op === "--" || e.op === "delete")) written = asParam(e.operand);
      if (e.kind === "call" && e.callee.kind === "member" &&
          (e.callee.property === "push" || e.callee.property === "pop" || e.callee.property === "delete")) {
        written = asParam(e.callee.object);
      }
      if (written) out.add(written);
    });
  });
  return out;
}

/**
 * Per function, the parameters it writes to -- directly, or by passing them to
 * one of the contract's own functions that writes to the matching parameter.
 * The second case matters because a `calldata` argument is *copied* into a
 * `memory` parameter: with `bump(values)` writing `values[0]`, a caller whose
 * `values` is calldata would no longer see the write, where TypeScript (and
 * a memory parameter) would. Closed under calls, to a fixed point.
 */
function mutatedParams(contract: IRContract): Map<IRFunction, Set<string>> {
  // Keyed by the function itself: Solidity allows overloads, and keying by name
  // let two same-named functions share one mutation set.
  const byName = new Map<string, IRFunction[]>();
  for (const f of contract.functions) byName.set(f.name, [...(byName.get(f.name) ?? []), f]);
  const aliases = new Map(contract.functions.map((f) => [f, paramAliases(contract, f)]));
  const mutated = new Map(contract.functions.map((f) => [f, directlyMutated(f, aliases.get(f)!)]));

  // Own-function calls whose arguments are rooted at a reference-typed parameter of the caller, or an alias of one.
  const flows: Array<{ caller: IRFunction; param: string; callee: string; index: number }> = [];
  for (const fn of contract.functions) {
    const params = new Set(fn.params.map((p) => p.name));
    const fnAliases = aliases.get(fn)!;
    walkScoped(fn.body, typeEnvFor(contract, fn), (stmt, scope) => {
      walkExpressionsInStatement(stmt, (e) => {
        if (e.kind !== "call") return;
        const callee = e.callee.kind === "member" && e.callee.object.kind === "this" ? e.callee.property
          : e.callee.kind === "identifier" ? e.callee.name : undefined;
        if (!callee || !byName.has(callee)) return;
        e.args.forEach((arg, index) => {
          const root = rootIdentifier(arg);
          const param = root ? (params.has(root) ? root : fnAliases.get(root)) : undefined;
          if (!param) return;
          // A value-typed element (`values[0]` of `bigint[]`) is copied whatever the location.
          const type = inferType(arg, scope);
          if (type && !needsLocationQualifier(type)) return;
          flows.push({ caller: fn, param, callee, index });
        });
      });
    });
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const f of flows) {
      // An overloaded name cannot be resolved by arity alone here, so any
      // candidate that writes to the matching position marks the argument.
      const writes = (byName.get(f.callee) ?? []).some((candidate) => {
        const target = candidate.params[f.index]?.name;
        return !!target && !!mutated.get(candidate)?.has(target);
      });
      if (!writes) continue;
      const set = mutated.get(f.caller)!;
      if (!set.has(f.param)) {
        set.add(f.param);
        changed = true;
      }
    }
  }
  return mutated;
}

/**
 * Parameters that a ternary would have to unify with a storage value. solc
 * accepts `cond ? memoryValue : storageValue` but not `cond ? calldataValue :
 * storageValue` ("True expression's type string calldata does not match false
 * expression's type string storage pointer"), and `a ?? b` lowers to exactly
 * that ternary. A reference-typed branch rooted at a parameter, with a storage
 * path as its sibling, keeps `memory`.
 */
function paramsBranchingAgainstStorage(contract: IRContract, fn: IRFunction): Set<string> {
  const params = new Set(fn.params.map((p) => p.name));
  const out = new Set<string>();
  walkScoped(fn.body, typeEnvFor(contract, fn), (stmt, scope) => {
    const check = (branch: IRExpression, sibling: IRExpression) => {
      const root = rootIdentifier(branch);
      if (!root || !params.has(root) || !isStorageAccess(sibling, scope)) return;
      // Unknown type: assume the worst, keeping memory costs gas rather than a build.
      const type = inferType(branch, scope);
      if (!type || needsLocationQualifier(type)) out.add(root);
    };
    walkExpressionsInStatement(stmt, (e) => {
      if (e.kind === "nullish") { check(e.left, e.right); check(e.right, e.left); }
      if (e.kind === "conditional") { check(e.consequent, e.alternate); check(e.alternate, e.consequent); }
    });
  });
  return out;
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

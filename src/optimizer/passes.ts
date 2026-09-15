import type { IRContract, IRExpression, IRProgram, IRStatement } from "../ir/types";
import { packSlots } from "./pack-slots";
import { cacheLength } from "./cache-length";
import { uncheckedArithmetic } from "./unchecked";
import { immutablePass } from "./immutable";
import { constantPass } from "./constant";
import { customErrors } from "./custom-errors";
import { calldataParams } from "./calldata-params";
import { storageCache } from "./storage-cache";
import { uncheckedLoop } from "./unchecked-loop";
import { preIncrement } from "./pre-increment";
import { zeroInitStrip } from "./zero-init-strip";
import { mappingLoadReuse } from "./mapping-load-reuse";
import { eventIndexedHint } from "./event-indexed-hint";

export interface OptimizationReport {
  contract: string;
  changes: OptimizationChange[];
}

export interface OptimizationChange {
  pass: string;
  detail: string;
  applied?: boolean;
}

export interface OptimizeOptions {
  /**
   * Let `pack-slots` reorder state variables to save storage slots.
   * Off by default: reordering rewrites the storage layout, which breaks
   * upgradeable proxies and anything else that depends on slot positions.
   */
  reorderStorage?: boolean;
}

export type Pass = (contract: IRContract, options: OptimizeOptions) => OptimizationChange[];

// Order matters: `immutable` and `constant` run before `pack-slots` so that
// variables which will not occupy storage are already marked when slots are counted.
export const PASSES: Array<{ name: string; fn: Pass }> = [
  { name: "immutable", fn: immutablePass },
  { name: "constant", fn: constantPass },
  { name: "pack-slots", fn: packSlots },
  { name: "zero-init-strip", fn: zeroInitStrip },
  { name: "custom-errors", fn: customErrors },
  { name: "calldata-params", fn: calldataParams },
  { name: "storage-cache", fn: storageCache },
  { name: "unchecked-loop", fn: uncheckedLoop },
  { name: "pre-increment", fn: preIncrement },
  { name: "mapping-load-reuse", fn: mappingLoadReuse },
  { name: "event-indexed-hint", fn: eventIndexedHint },
  { name: "cache-length", fn: cacheLength },
  { name: "unchecked", fn: uncheckedArithmetic },
];

import { getPluginOptimizerPasses } from "../plugin/api";

export function optimizeProgram(program: IRProgram, options: OptimizeOptions = {}): OptimizationReport[] {
  return program.contracts.map((c) => optimizeContract(c, options));
}

export function optimizeContract(contract: IRContract, options: OptimizeOptions = {}): OptimizationReport {
  const changes: OptimizationChange[] = [];
  for (const pass of PASSES) {
    const passChanges = pass.fn(contract, options);
    for (const ch of passChanges) changes.push(ch);
  }
  for (const plugin of getPluginOptimizerPasses()) {
    const passChanges = plugin.run(contract);
    for (const ch of passChanges) changes.push({ ...ch, pass: `plugin:${plugin.name}` });
  }
  return { contract: contract.name, changes };
}

export function walkStatements(stmts: IRStatement[], visit: (s: IRStatement, parent: IRStatement[] | null) => void): void {
  for (const s of stmts) {
    visit(s, stmts);
    if (s.kind === "if") {
      walkStatements(s.then, visit);
      if (s.else) walkStatements(s.else, visit);
    }
    if (s.kind === "for" || s.kind === "while" || s.kind === "block") {
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
  }
}

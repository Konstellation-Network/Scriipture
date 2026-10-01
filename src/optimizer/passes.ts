import type { IRContract, IRProgram } from "../ir/types";
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
import { stateWrites } from "./walk";
import { ancestorsOf, basesFirst } from "../mapper/lineage";

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
  /**
   * State variables of this contract that a contract derived from it writes.
   * A per-contract pass cannot see those writes, and freezing such a variable
   * as `constant` / `immutable` makes the derived contract fail to compile.
   * `optimizeProgram` fills it in.
   */
  writtenByDerived?: Set<string>;
  /**
   * Errors declared by this contract's bases in the build, by name, with
   * their parameter count, so `custom-errors` reuses an inherited error
   * instead of declaring a duplicate. `optimizeProgram` fills it in.
   */
  inheritedErrors?: Map<string, number>;
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
  const derivedWrites = writesByDerivedContracts(program);
  // Bases first, so the errors `custom-errors` synthesizes in a base are
  // there for its derived contracts to reuse. Reports keep program order.
  const reports = new Map<IRContract, OptimizationReport>();
  for (const c of basesFirst(program)) {
    const inheritedErrors = new Map(ancestorsOf(c, program).flatMap((b) => b.errors.map((e) => [e.name, e.params.length] as const)));
    reports.set(c, optimizeContract(c, { ...options, writtenByDerived: derivedWrites.get(c.name), inheritedErrors }));
  }
  return program.contracts.map((c) => reports.get(c)!);
}

/** For each contract, the state variables written by the contracts in this program that inherit from it. */
function writesByDerivedContracts(program: IRProgram): Map<string, Set<string>> {
  const byName = new Map(program.contracts.map((c) => [c.name, c]));
  const out = new Map<string, Set<string>>();
  for (const c of program.contracts) {
    const written = new Set<string>();
    for (const fn of c.functions) for (const n of stateWrites(fn.body)) written.add(n);
    // Every ancestor sees the writes, since a variable may be declared several levels up.
    const seen = new Set<string>();
    const visit = (name: string): void => {
      const base = byName.get(name);
      if (!base || seen.has(name)) return;
      seen.add(name);
      const set = out.get(name) ?? new Set<string>();
      for (const n of written) set.add(n);
      out.set(name, set);
      for (const b of base.bases) visit(b);
    };
    for (const b of c.bases) visit(b);
  }
  return out;
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

// The shared walkers, re-exported for the passes that import them from here.
// This module used to carry its own copies, which skipped `unchecked` bodies
// and `for` initializers, so a pass could miss a write it needed to see.
export { walkStatements, walkExpr } from "./walk";

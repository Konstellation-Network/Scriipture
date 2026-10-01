import type { IRContract } from "../ir/types";
import { stateWrites } from "./walk";
import type { OptimizationChange, OptimizeOptions } from "./passes";

export function constantPass(contract: IRContract, options: OptimizeOptions = {}): OptimizationChange[] {
  const changes: OptimizationChange[] = [];

  const assignedAnywhere = new Set<string>(options.writtenByDerived);
  for (const fn of contract.functions) for (const name of stateWrites(fn.body)) assignedAnywhere.add(name);

  for (const v of contract.stateVars) {
    if (v.type.kind !== "primitive") continue;
    if (v.mutability || v.transient) continue;
    if (!v.initializer) continue;
    if (v.initializer.kind !== "literal") continue;
    if (assignedAnywhere.has(v.name)) continue;
    v.mutability = "constant";
    changes.push({
      pass: "constant",
      detail: `state var "${v.name}" marked constant (literal init, never reassigned)`,
      applied: true,
    });
  }
  return changes;
}

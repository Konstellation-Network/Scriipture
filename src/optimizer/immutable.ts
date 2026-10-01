import type { IRContract } from "../ir/types";
import { stateWrites } from "./walk";
import { isValueType } from "../mapper/types";
import type { OptimizationChange, OptimizeOptions } from "./passes";

export function immutablePass(contract: IRContract, options: OptimizeOptions = {}): OptimizationChange[] {
  const changes: OptimizationChange[] = [];
  const ctor = contract.functions.find((f) => f.isConstructor);
  if (!ctor) return changes;

  const assignedInCtor = stateWrites(ctor.body);
  const assignedElsewhere = new Set<string>(options.writtenByDerived);
  for (const fn of contract.functions) {
    if (fn.isConstructor) continue;
    for (const name of stateWrites(fn.body)) assignedElsewhere.add(name);
  }

  for (const v of contract.stateVars) {
    // Solidity allows `immutable` on value types only: not `string` or `bytes`.
    if (!isValueType(v.type)) continue;
    if (v.mutability) continue;
    if (assignedInCtor.has(v.name) && !assignedElsewhere.has(v.name)) {
      v.mutability = "immutable";
      changes.push({
        pass: "immutable",
        detail: `state var "${v.name}" marked immutable (only set in constructor)`,
        applied: true,
      });
    }
  }

  return changes;
}

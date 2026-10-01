import type { IRContract, IRProgram } from "../ir/types";

/**
 * Every contract `contract` inherits from that is defined in this build,
 * nearest first, each once. Bases Scriipture bundles (OpenZeppelin) are not
 * in the program and so are not listed.
 */
export function ancestorsOf(contract: IRContract, program: IRProgram | undefined): IRContract[] {
  const byName = new Map((program?.contracts ?? []).map((c) => [c.name, c]));
  const out: IRContract[] = [];
  const seen = new Set<string>([contract.name]);
  const queue = [...contract.bases];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const base = byName.get(name);
    if (!base) continue;
    out.push(base);
    queue.push(...base.bases);
  }
  return out;
}

/** The build's contracts ordered so that every base comes before the contracts derived from it. */
export function basesFirst(program: IRProgram): IRContract[] {
  const byName = new Map(program.contracts.map((c) => [c.name, c]));
  const out: IRContract[] = [];
  const done = new Set<string>();
  const visit = (c: IRContract, path: Set<string>): void => {
    if (done.has(c.name) || path.has(c.name)) return;
    path.add(c.name);
    for (const b of c.bases) { const base = byName.get(b); if (base) visit(base, path); }
    done.add(c.name);
    out.push(c);
  };
  for (const c of program.contracts) visit(c, new Set());
  return out;
}

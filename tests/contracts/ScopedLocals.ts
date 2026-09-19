import { storage } from "scriipture";

interface Meta { votes: bigint; }
interface Proposal { meta: Meta; }

export class ScopedLocals {
  @storage proposals: Map<bigint, Proposal> = new Map();

  // the same name bound to storage in one branch and to a memory value in the
  // other: each branch must be typed on its own, in either order
  vote(id: bigint, other: Proposal): void {
    if (id > 0n) { const p = this.proposals.get(id); const m = p.meta; m.votes = m.votes + 1n; }
    else         { const p = other;                  const m = p.meta; m.votes = m.votes + 1n; }
  }

  voteRev(id: bigint, other: Proposal): void {
    if (id > 0n) { const p = other;                  const m = p.meta; m.votes = m.votes + 1n; }
    else         { const p = this.proposals.get(id); const m = p.meta; m.votes = m.votes + 1n; }
  }

  // a ternary of two storage paths is a storage pointer
  voteEither(useA: boolean): void {
    const p = useA ? this.proposals.get(1n) : this.proposals.get(2n);
    p.meta.votes = p.meta.votes + 1n;
  }

  // a loop variable is scoped to its loop, and typed there
  count(n: bigint): bigint {
    let total: bigint = 0n;
    for (let i = 0n; i < n; i++) { total = total + i; }
    return total;
  }
}

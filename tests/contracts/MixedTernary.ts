import { storage } from "scriipture";

interface Proposal { votes: bigint; }

export class MixedTernary {
  @storage proposals: Map<bigint, Proposal> = new Map();

  // one storage branch, one memory branch: no local can alias both
  vote(useA: boolean, other: Proposal): void {
    const p = useA ? this.proposals.get(1n) : other;
    p.votes = p.votes + 1n;
  }
}

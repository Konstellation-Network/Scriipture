import { storage } from "scriipture";

interface Rec { a: bigint; }

export class BadLowering {
  @storage recs: Map<bigint, Rec> = new Map();

  bad(id: bigint, other: bigint): void {
    // struct-typed left side: no emptiness test → error
    const r = this.recs.get(id) ?? { a: 1n } as Rec;
    // unknown shape without annotation → error
    const [x, y] = this.helper(other);
  }

  helper(v: bigint): any {
    return v;
  }
}

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

  // a call on the left: the lowering reads the left side twice, so it would run twice → error
  next(): bigint {
    return this.recs.get(this.bump()).a ?? 1n;
  }

  // an update on the left, same problem
  nextAt(i: bigint): bigint {
    return this.recs.get(i++).a ?? 1n;
  }

  bump(): bigint {
    return 1n;
  }

  helper(v: bigint): any {
    return v;
  }
}

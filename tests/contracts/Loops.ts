import { storage, view } from "scriipture";

export class Loops {
  @storage xs: Array<bigint> = [];

  @view
  firstNonZero(): bigint {
    for (let i = 0n; i < this.xs.length; i = i + 1n) {
      if (this.xs[i] == 0n) { continue; }
      return this.xs[i];
    }
    return 0n;
  }

  @view
  countUntil(limit: bigint): bigint {
    let n: bigint = 0n;
    for (let i = 0n; i < this.xs.length; i = i + 1n) {
      if (n >= limit) { break; }
      n = n + 1n;
    }
    return n;
  }
}

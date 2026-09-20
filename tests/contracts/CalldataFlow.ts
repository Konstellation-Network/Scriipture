import { storage, external } from "scriipture";

export class CalldataFlow {
  @storage xs: Array<bigint> = [];

  bump(values: Array<bigint>): void {
    values[0] = values[0] + 1n;
  }

  // `values` flows into bump, which writes to it: a calldata argument would be
  // copied into bump's memory parameter and the caller would not see the write
  @external
  bumpAndRead(values: Array<bigint>): bigint {
    this.bump(values);
    return values[0];
  }

  // the same through two hops
  @external
  bumpViaHelper(values: Array<bigint>): bigint {
    this.viaHelper(values);
    return values[0];
  }

  viaHelper(ys: Array<bigint>): void {
    this.bump(ys);
  }

  // a helper that only reads leaves calldata legal
  @external
  sumOf(values: Array<bigint>): bigint {
    return this.sum(values);
  }

  sum(ys: Array<bigint>): bigint {
    return ys[0];
  }

  // an own function called from a for-initializer is an internal call site too
  start(values: Array<bigint>): bigint {
    return values[0];
  }

  @external
  loop(): bigint {
    let acc: bigint = 0n;
    for (let i = this.start(this.xs); i < 3n; i++) { acc = acc + i; }
    return acc;
  }
}

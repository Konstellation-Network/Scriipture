import { storage, view } from "scriipture";

export class Ledger {
  @storage total: bigint = 0n;

  credit(v: bigint): void {
    this.total = this.total + v;
  }
}

export class CappedLedger extends Ledger {
  @storage cap: bigint = 100n;

  @view
  headroom(): bigint {
    return this.cap;
  }
}

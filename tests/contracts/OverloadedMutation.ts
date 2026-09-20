import { storage, view, external } from "scriipture";

/** Two functions sharing a name, only one of which writes to its parameter. */
export class OverloadedMutation {
  @storage total: bigint = 0n;

  @external
  @view
  apply(xs: Array<bigint>): bigint {
    return xs[0];
  }

  @external
  apply(xs: Array<bigint>, n: bigint): void {
    xs[0] = n;
    this.total = n;
  }
}

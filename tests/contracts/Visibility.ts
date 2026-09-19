import { storage, private_, public_, internal } from "scriipture";

export class Visibility {
  @storage total: bigint = 0n;

  @private_
  step(x: bigint): bigint {
    return x + 1n;
  }

  @internal
  twice(x: bigint): bigint {
    return this.step(this.step(x));
  }

  @public_
  bump(): void {
    this.total = this.twice(this.total);
  }
}

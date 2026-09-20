import { storage, view } from "scriipture";

/** TypeScript's own visibility keywords, which are not decorators. */
export class TsVisibility {
  @storage total: bigint = 0n;
  private secret: bigint = 42n;
  protected guarded: bigint = 7n;

  private double(v: bigint): bigint {
    return v * 2n;
  }

  protected internalOnly(): bigint {
    return this.secret;
  }

  @view
  readTotal(): bigint {
    return this.total;
  }

  add(v: bigint): void {
    this.total = this.total + this.double(v);
  }
}

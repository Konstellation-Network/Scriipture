import { storage } from "scriipture";

export class UnsupportedExpr {
  @storage tags: Array<bigint> = [];
  @storage name: string = "a";

  fill(): void {
    this.tags = [1n, 2n, 3n];
  }

  probe(): boolean {
    return typeof this.name === "string";
  }

  shift(v: bigint): bigint {
    return v >>> 1n;
  }

  blank(): bigint {
    return undefined;
  }
}

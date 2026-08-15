import { storage, view, onlyOwner } from "scriipture";

export class Counter {
  @storage count: bigint = 0n;

  @onlyOwner
  increment(): void {
    this.count = this.count + 1n;
  }

  @onlyOwner
  decrement(): void {
    this.count = this.count - 1n;
  }

  @view
  current(): bigint {
    return this.count;
  }
}

import { storage } from "scriipture";

export class Unsupported {
  @storage total: bigint = 0n;
  static VERSION: bigint = 1n;

  get current(): bigint { return this.total; }
  set current(v: bigint) { this.total = v; }

  optional(a: bigint, b?: bigint): void { this.total = a; }
  defaulted(a: bigint = 5n): void { this.total = a; }
  rest(...vals: bigint[]): void { this.total = vals[0]; }

  sw(v: bigint): void {
    switch (v) { case 1n: this.total = 1n; break; default: this.total = 0n; }
  }
  dw(): void { do { this.total = this.total + 1n; } while (this.total < 3n); }
  tc(): void { try { this.total = 1n; } catch (e) { this.total = 2n; } }
}

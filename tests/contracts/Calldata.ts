import { Address, storage, view, external } from "scriipture";

export class Calldata {
  @storage names: Map<Address, string> = new Map();

  // Only the outside world calls this, and `name` is never written → calldata.
  @external
  @view
  greet(name: string): string {
    return name;
  }

  // Same shape, but called internally below, so it must keep `memory`:
  // a calldata parameter cannot accept the storage string passed at that call site.
  @view
  len(s: string): bigint {
    return s.length;
  }

  @view
  nameLength(who: Address): bigint {
    return this.len(this.names.get(who) ?? "");
  }

  // `delete values[0]` writes through the parameter → memory.
  @external
  clearFirst(values: Array<bigint>): bigint {
    delete values[0];
    return values[0];
  }

  // Never written and never called internally → calldata.
  @external
  @view
  sum(values: Array<bigint>): bigint {
    let total: bigint = 0n;
    for (let i = 0n; i < values.length; i = i + 1n) {
      total = total + values[i];
    }
    return total;
  }
}

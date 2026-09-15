import { Address, storage, view } from "scriipture";

// Declaration order deliberately interleaves 8-bit bools with full-slot uint256s,
// so solc's adjacent packing yields 6 slots while a reordering needs 4.
export class PackSlots {
  @storage flagA: boolean = false;
  @storage supply: bigint = 0n;
  @storage flagB: boolean = false;
  @storage cap: bigint = 0n;
  @storage flagC: boolean = false;
  @storage FEE: bigint = 5n;
  @storage balances: Map<Address, bigint> = new Map();

  toggle(): void {
    this.flagA = !this.flagA;
    this.flagB = !this.flagB;
    this.flagC = !this.flagC;
  }

  setSupply(v: bigint): void {
    this.supply = v;
    this.cap = v;
  }

  @view
  fee(): bigint {
    return this.FEE;
  }
}

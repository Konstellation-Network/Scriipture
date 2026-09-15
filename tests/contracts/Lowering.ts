import { Address, Bytes, storage, view, msg, validate, CheckedAddress } from "scriipture";

export class Lowering {
  @storage balances: Map<Address, bigint> = new Map();
  @storage names: Map<Address, string> = new Map();
  @storage delegate: Address = msg.sender;
  @storage paused: boolean = false;
  @storage tags: Array<bigint> = [];

  // string param never written → calldata
  @view
  greet(name: string): string {
    return name;
  }

  // array param written through an index → memory
  bump(values: Array<bigint>): bigint {
    values[0] = values[0] + 1n;
    return values[0];
  }

  // array param read-only → calldata
  @view
  first(values: Array<bigint>): bigint {
    return values[0];
  }

  // `?? 0n` is the type's default: lowers to a bare read
  @view
  balanceOf(who: Address): bigint {
    return this.balances.get(who) ?? 0n;
  }

  // non-default fallback on a numeric storage read → explicit test
  @view
  balanceOrMin(who: Address): bigint {
    return this.balances.get(who) ?? 1n;
  }

  // address fallback
  @view
  target(): Address {
    return this.delegate ?? msg.sender;
  }

  // string fallback
  @view
  nameOf(who: Address): string {
    return this.names.get(who) ?? "anon";
  }

  // bool fallback
  @view
  isPaused(): boolean {
    return this.paused ?? true;
  }

  // low-level call destructuring with an omitted slot
  ping(to: Address): void {
    const safe: CheckedAddress = validate(to);
    const [ok,] = (safe as any).call("");
    require(ok, "call failed");
  }

  // both components
  poke(to: Address): Bytes {
    const safe: CheckedAddress = validate(to);
    const [ok, data] = (safe as any).call("");
    require(ok, "call failed");
    return data;
  }

  // explicit tuple annotation
  @view
  pair(): bigint {
    const [a, b]: [bigint, boolean] = this.twoValues();
    return b ? a : 0n;
  }

  @view
  twoValues(): any {
    return solidity`(uint256(1), true)`;
  }
}

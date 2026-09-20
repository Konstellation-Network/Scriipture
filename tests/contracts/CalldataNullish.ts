import { Address, storage, view, external } from "scriipture";

export class CalldataNullish {
  @storage names: Map<Address, string> = new Map();
  @storage tags: Array<bigint> = [];

  // a string param as a `??` branch against a storage string: solc cannot
  // unify `string calldata` with `string storage pointer`, so it keeps memory
  @external
  @view
  nameOr(who: Address, fb: string): string {
    return this.names.get(who) ?? fb;
  }

  // the same pair through an explicit ternary
  @external
  @view
  pick(who: Address, fb: string, useFb: boolean): string {
    return useFb ? fb : this.names.get(who);
  }

  // a value-typed element unifies with anything: calldata stays
  @external
  @view
  firstOr(xs: Array<bigint>): bigint {
    return xs[0] ?? this.tags[0];
  }

  // against a literal, calldata is fine
  @external
  @view
  greet(name: string): string {
    return name ?? "anon";
  }
}

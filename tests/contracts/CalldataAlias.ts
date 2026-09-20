import { external } from "scriipture";

interface Rec { votes: bigint; }

export class CalldataAlias {
  // written through a local alias: must stay memory
  @external
  bumpFirst(values: Array<bigint>): bigint {
    const v = values;
    v[0] = v[0] + 1n;
    return values[0];
  }

  // an element alias of a struct array
  @external
  bumpRec(recs: Array<Rec>): bigint {
    const r = recs[0];
    r.votes = r.votes + 1n;
    return recs[0].votes;
  }

  // an alias passed to a mutating helper
  @external
  bumpVia(values: Array<bigint>): bigint {
    const v = values;
    this.bump(v);
    return values[0];
  }

  bump(xs: Array<bigint>): void {
    xs[0] = xs[0] + 1n;
  }

  // a value-typed alias is a copy under any location: calldata stays
  @external
  readFirst(values: Array<bigint>): bigint {
    const x = values[0];
    return x + 1n;
  }

  // an alias that is only read: calldata stays
  @external
  sumAlias(values: Array<bigint>): bigint {
    const v = values;
    return v[0];
  }
}

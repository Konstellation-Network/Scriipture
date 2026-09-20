import { Address, storage, view } from "scriipture";

interface Meta { votes: bigint; }
interface Proposal { meta: Meta; owner: Address; tags: Array<bigint>; }

export class StorageRefs {
  @storage proposals: Map<bigint, Proposal> = new Map();
  @storage items: Array<Proposal> = [];
  @storage balances: Map<Address, bigint> = new Map();
  @storage names: Map<Address, string> = new Map();

  // a struct field reached through a mapping read is still storage
  vote(id: bigint): void {
    const m = this.proposals.get(id).meta;
    m.votes = m.votes + 1n;
  }

  // …and through a local that is itself a storage pointer
  voteAt(i: bigint): void {
    const p = this.items[i];
    const m = p.meta;
    m.votes = m.votes + 1n;
  }

  // an array field is a reference too, so the push reaches storage
  tag(id: bigint, t: bigint): void {
    const tags = this.proposals.get(id).tags;
    tags.push(t);
  }

  // a value-typed field is a copy
  @view
  votesOf(id: bigint): bigint {
    const v = this.proposals.get(id).meta.votes;
    return v;
  }

  // an untyped local takes its type from the initializer, for the validator and the emitter alike
  @view
  balanceOr(who: Address): bigint {
    const b = this.balances.get(who);
    return b ?? 7n;
  }

  @view
  nameLength(who: Address): bigint {
    const s = this.names.get(who);
    return s.length;
  }
}

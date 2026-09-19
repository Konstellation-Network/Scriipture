import { Address, storage, view, msg } from "scriipture";

export enum Status { Pending, Active, Closed }

export interface Item {
  id: bigint;
  owner: Address;
}

/** A TypeScript-only shape: not a struct, and must not be emitted as one. */
export interface Callbacks {
  onDone(): void;
}

export class Registry {
  @storage items: Map<bigint, Item> = new Map();
  @storage status: Status = Status.Pending;

  setStatus(s: Status): void {
    this.status = s;
  }

  put(id: bigint, it: Item): void {
    this.items.set(id, it);
  }

  claim(id: bigint): void {
    this.items.set(id, { id, owner: msg.sender });
  }

  @view
  ownerOf(id: bigint): Address {
    return this.items.get(id)!.owner;
  }
}

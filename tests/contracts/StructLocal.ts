import { Address, storage, view, msg } from "scriipture";

export interface Proposal { id: bigint; owner: Address; }

export class StructLocal {
  @storage items: Map<bigint, Proposal> = new Map();

  fromLiteral(): void {
    const p = { id: 1n, owner: msg.sender } as Proposal;
    this.items.set(p.id, p);
  }

  fromCall(id: bigint): void {
    const q = this.draft(id);
    this.items.set(id, q);
  }

  @view
  draft(id: bigint): Proposal {
    return { id, owner: msg.sender } as Proposal;
  }
}

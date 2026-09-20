import { Address, CheckedAddress, storage, view, msg } from "scriipture";

export class CheckedFallback {
  @storage owners: Map<bigint, CheckedAddress> = new Map();

  @view
  ownerOr(id: bigint): Address {
    return this.owners.get(id) ?? msg.sender;
  }

  @view
  toOr(to: CheckedAddress): Address {
    return to ?? msg.sender;
  }
}

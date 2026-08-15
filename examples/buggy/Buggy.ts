import { Address, storage, msg } from "scriipture";

export class Buggy {
  @storage owner!: Address;

  constructor() {
    this.owner = msg.sender;
  }

  withdraw(): void {
    require(tx.origin == this.owner, "Not owner");
    payable(msg.sender).transfer(address(this).balance);
  }
}

declare const tx: { origin: Address };
declare function payable(a: Address): { transfer(v: bigint): void };
declare function address(c: object): { balance: bigint };

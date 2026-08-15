import { Address, storage, view, onlyOwner, nonReentrant, payable, msg } from "scriipture";

export class Vault {
  @storage deposits: Map<Address, bigint> = new Map();
  @storage totalDeposits: bigint = 0n;

  @payable
  deposit(): void {
    this.deposits.set(msg.sender, (this.deposits.get(msg.sender) ?? 0n) + msg.value);
    this.totalDeposits = this.totalDeposits + msg.value;
  }

  @nonReentrant
  withdraw(amount: bigint): void {
    const balance = this.deposits.get(msg.sender) ?? 0n;
    this.deposits.set(msg.sender, balance - amount);
    this.totalDeposits = this.totalDeposits - amount;
  }

  @view
  balanceOf(account: Address): bigint {
    return this.deposits.get(account) ?? 0n;
  }
}

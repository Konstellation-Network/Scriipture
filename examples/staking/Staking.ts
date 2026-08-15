import { Address, storage, view, onlyOwner, payable, msg } from "scriipture";

export class Staking {
  @storage stakes: Map<Address, bigint> = new Map();
  @storage totalStaked: bigint = 0n;
  @storage minStake: bigint = 1000000000000000000n;

  @payable
  stake(): void {
    require(msg.value >= this.minStake, "Stake below minimum");
    this.stakes.set(msg.sender, (this.stakes.get(msg.sender) ?? 0n) + msg.value);
    this.totalStaked = this.totalStaked + msg.value;
  }

  unstake(amount: bigint): void {
    const balance = this.stakes.get(msg.sender) ?? 0n;
    require(balance >= amount, "Insufficient stake");
    this.stakes.set(msg.sender, balance - amount);
    this.totalStaked = this.totalStaked - amount;
  }

  @view
  balanceOf(account: Address): bigint {
    return this.stakes.get(account) ?? 0n;
  }

  @onlyOwner
  bumpRange(start: bigint, end: bigint): void {
    for (let i: bigint = start; i < end; i++) {
      this.totalStaked = this.totalStaked + 1n;
    }
  }
}

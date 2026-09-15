import { Address, CheckedAddress, storage, payable, msg, validate, pullPayment, allowZeroAddress } from "scriipture";

export class Payout {
  @storage balances: Map<Address, bigint> = new Map();

  // unchecked param reaches transfer → flagged
  payRaw(to: Address, amount: bigint): void {
    payable(to).transfer(amount);
  }

  // alias of an unchecked param → flagged
  payAlias(to: Address, amount: bigint): void {
    const dest = to;
    payable(dest).transfer(amount);
  }

  // unchecked param into pullPayment → flagged
  queueRaw(to: Address, amount: bigint): void {
    pullPayment(to as CheckedAddress, amount);
  }

  // validated → clean
  payChecked(to: Address, amount: bigint): void {
    const safe: CheckedAddress = validate(to);
    payable(safe).transfer(amount);
  }

  // inline validate → clean
  payInline(to: Address, amount: bigint): void {
    payable(validate(to)).transfer(amount);
  }

  // CheckedAddress param → clean
  payTyped(to: CheckedAddress, amount: bigint): void {
    payable(to).transfer(amount);
  }

  // msg.sender is CheckedAddress → clean
  refund(): void {
    payable(msg.sender).transfer(this.balances.get(msg.sender) ?? 0n);
  }

  @allowZeroAddress("burn sink is intentionally unchecked")
  burn(to: Address, amount: bigint): void {
    payable(to).transfer(amount);
  }
}

declare function payable(a: Address): { transfer(v: bigint): void };

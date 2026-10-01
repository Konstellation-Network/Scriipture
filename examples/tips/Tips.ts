import { Address, Indexed, storage, view, modifier, event, error, msg, emit, at, require } from "scriipture";

declare const onlyAdmin: MethodDecorator;

export interface IERC20 {
  transfer(to: Address, amount: bigint): boolean;
}

export class Tips {
  @storage admin: Address;
  @storage tipped: Map<Address, bigint> = new Map();

  @event Tipped(from: Indexed<Address>, to: Indexed<Address>, amount: bigint): void {}
  @error ZeroTip(): void {}

  constructor() {
    this.admin = msg.sender;
  }

  @modifier
  onlyAdmin(): void {
    require(msg.sender === this.admin, "not admin");
  }

  tip(token: Address, to: Address, amount: bigint): void {
    if (amount === 0n) throw this.ZeroTip();
    require(at<IERC20>(token).transfer(to, amount), "transfer failed");
    this.tipped.set(to, (this.tipped.get(to) ?? 0n) + amount);
    emit(this.Tipped(msg.sender, to, amount));
  }

  @view
  totalFor(who: Address): bigint {
    return this.tipped.get(who) ?? 0n;
  }

  @onlyAdmin
  handOver(next: Address): void {
    this.admin = next;
  }
}

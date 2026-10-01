// Solidity constructs written the TypeScript way. This file must type-check
// against types/index.d.ts *and* transpile to Solidity that solc accepts;
// tests/solidity-parity.test.ts checks both.
import {
  Address,
  Bytes,
  Bytes4,
  Uint8,
  Uint64,
  FixedArray,
  Indexed,
  storage,
  view,
  pure,
  payable,
  external,
  modifier,
  event,
  error,
  msg,
  block,
  require,
  emit,
  abi,
  keccak256,
  at,
  type,
  address,
  unchecked,
  ether,
  days,
  _,
} from "scriipture";

declare const onlyKeeper: MethodDecorator;
declare const notBefore: (t: bigint) => MethodDecorator;

/** An ERC-20 as seen from outside. */
export interface IERC20 {
  transfer(to: Address, amount: bigint): boolean;
  /** @view */
  balanceOf(owner: Address): bigint;
}

export interface IPriced {
  /** @view */
  price(): [bigint, Uint8];
}

export enum Phase { Open, Closed }

/** Shared plumbing; `fee` is left to each vault. */
export abstract class VaultBase implements IPriced {
  @storage keeper: Address;
  @storage phase: Phase = Phase.Open;
  @storage history!: FixedArray<bigint, 3>;

  constructor() {
    this.keeper = msg.sender;
  }

  @event Deposited(who: Indexed<Address>, amount: bigint): void {}
  @error TooSmall(amount: bigint, min: bigint): void {}

  @modifier
  onlyKeeper(): void {
    require(msg.sender === this.keeper, "not keeper");
    _;
  }

  @modifier
  notBefore(t: bigint): void {
    require(block.timestamp >= t, "too early");
  }

  /** Fee taken from a deposit. @view */
  abstract fee(amount: bigint): bigint;

  @view
  price(): [bigint, Uint8] {
    return [1n * ether, 18n as Uint8];
  }
}

export class Vault extends VaultBase {
  @storage deposits: Map<Address, bigint> = new Map();
  @storage total: bigint = 0n;
  @storage lastSweep: bigint = 0n;
  @storage received: bigint = 0n;

  @view
  fee(amount: bigint): bigint {
    return amount / 100n;
  }

  @payable
  deposit(): void {
    if (msg.value < 1n * ether / 1000n) throw this.TooSmall(msg.value, 1n * ether / 1000n);
    const net = msg.value - this.fee(msg.value);
    this.deposits.set(msg.sender, (this.deposits.get(msg.sender) ?? 0n) + net);
    this.total += net;
    emit(this.Deposited(msg.sender, net));
  }

  @payable
  receive(): void {
    this.received += msg.value;
  }

  /** Sweep a stray token to the keeper, tolerating a token that reverts. */
  @onlyKeeper
  @notBefore(7n * days)
  sweep(token: Address): bigint {
    let swept = 0n;
    try {
      const bal = at<IERC20>(token).balanceOf(address(this));
      const ok = at<IERC20>(token).transfer(this.keeper, bal);
      require(ok, "transfer failed");
      swept = bal;
    } catch {
      swept = 0n;
    }
    this.lastSweep = block.timestamp;
    return swept;
  }

  @view
  split(amount: bigint): [bigint, bigint] {
    const f = this.fee(amount);
    return [amount - f, f];
  }

  @view
  summary(): [bigint, boolean] {
    const [net, f] = this.split(this.total);
    return [net, f > 0n];
  }

  @pure
  narrow(x: bigint): Uint64 {
    require(x <= type<Uint64>().max, "too big");
    return x as Uint64;
  }

  @pure
  countdown(n: Uint8): bigint {
    let steps = 0n;
    do {
      unchecked(() => {
        steps = steps + 1n;
      });
    } while (steps < BigInt(n));
    return steps;
  }

  @pure
  decode(data: Bytes): Address {
    const [to, amount] = abi.decode<[Address, bigint]>(data);
    require(amount > 0n, "empty");
    return to;
  }

  @pure
  @external
  selector(): Bytes4 {
    return "0xa9059cbb" as Bytes4;
  }

  @view
  digest(salt: bigint): boolean {
    const h = keccak256(abi.encode(salt, this.total));
    const isContract = this.keeper.code.length > 0n;
    return isContract && h !== keccak256(abi.encode(0n));
  }

  @view
  phaseCode(): bigint {
    return BigInt(this.phase);
  }
}

export class VaultFactory {
  @storage vaults: Address[] = [];

  create(): Address {
    const v = new Vault();
    const a = address(v);
    this.vaults.push(a);
    return a;
  }
}

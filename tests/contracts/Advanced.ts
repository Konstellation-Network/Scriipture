// The Solidity constructs that need more than a class: libraries, free
// functions and file-level constants, function types, user-defined value
// types, overloads, named returns, CREATE2, typed catch clauses, anonymous
// events and transient storage. Like Parity.ts, this file must type-check
// against types/index.d.ts and transpile to Solidity solc accepts;
// tests/solidity-parity.test.ts checks both, and runs
// tests/contracts/Advanced.behavior.t.sol against it when forge is installed.
import {
  Address,
  Bytes32,
  Indexed,
  Uint128,
  ValueType,
  Pure,
  storage,
  view,
  pure,
  payable,
  event,
  error,
  msg,
  require,
  emit,
  at,
  address,
  keccak256,
  library,
  using,
  overload,
  transient,
  create,
  wrap,
  unwrap,
  catchError,
  catchPanic,
} from "scriipture";

/** A price in wei per unit; never mixed up with a plain amount. */
export type Price = ValueType<Uint128, "Price">;

export interface Point {
  x: bigint;
  y: bigint;
}

/** Something that measures shapes, deployed elsewhere. */
export interface IMeasure {
  /** @view */
  area(p: Point): bigint;
  /** @view */
  quote(): Price;
}

/** Upper bound on any stored amount. */
const MAX_AMOUNT = 1_000_000n;
const TAG: Bytes32 = keccak256("advanced");

/** Clamp `v` to at most `hi`. */
export function clamp(v: bigint, hi: bigint): bigint {
  return v > hi ? hi : v;
}

export function origin(): Point {
  return { x: 0n, y: 0n };
}

@library
export class MathLib {
  static readonly ONE: bigint = 1n;

  @pure static max(a: bigint, b: bigint): bigint {
    return a > b ? a : b;
  }

  @pure static norm(p: Point): bigint {
    return p.x * p.x + p.y * p.y;
  }
}

export class Measurer {
  @storage side: bigint;

  /** @payable */
  constructor(side: bigint) {
    this.side = side;
  }

  @view area(p: Point): bigint {
    return MathLib.norm(p) + this.side * this.side;
  }

  @pure quote(): Price {
    return wrap<Price>(42n as Uint128);
  }
}

/** A measurer that always fails, a different way per `p.x`, for the catch clauses. */
export class Broken {
  @error Odd(x: bigint): void {}

  @pure area(p: Point): bigint {
    if (p.x === 1n) throw new Error("one");
    if (p.x === 2n) return 1n / (p.y - p.y);
    throw this.Odd(p.x);
  }

  @pure quote(): Price {
    return wrap<Price>(0n as Uint128);
  }
}

@using(MathLib)
export class Advanced {
  @storage total: bigint = 0n;
  @storage last!: Price;
  @storage outcome: bigint = 0n;
  @storage measurer!: Address;
  @transient @storage entered!: boolean;

  @event({ anonymous: true }) Moved(from: Indexed<Address>, to: Indexed<Address>, amount: Indexed<bigint>, tag: Indexed<Bytes32>): void {}

  @overload("put") putOne(a: bigint): void {
    this.total = clamp(a, MAX_AMOUNT);
  }

  @overload("put") putTwo(a: bigint, b: bigint): void {
    this.putOne(MathLib.max(a, b));
  }

  @view split(): [half: bigint, odd: boolean] {
    const half = this.total / 2n;
    return [half, this.total % 2n === 1n];
  }

  setPrice(p: Uint128): void {
    this.last = wrap<Price>(p);
  }

  @view price(): Uint128 {
    return unwrap(this.last);
  }

  @pure private applyTwice(f: Pure<(a: bigint) => bigint>, x: bigint): bigint {
    return f(f(x));
  }

  @pure private triple(a: bigint): bigint {
    return a * 3n;
  }

  @pure nine(x: bigint): bigint {
    return this.applyTwice(this.triple, x);
  }

  @payable spawn(salt: Bytes32, side: bigint): Address {
    const m = create(Measurer, { salt, value: msg.value }, side);
    this.measurer = address(m);
    return this.measurer;
  }

  @view areaAt(target: Address): bigint {
    return at<IMeasure>(target).area(origin());
  }

  /** Records the area, or 1 for a reason string, 2 for a panic, 3 for anything else. */
  probe(target: Address, p: Point): void {
    try {
      const a = at<IMeasure>(target).area(p);
      this.outcome = a;
    } catch {
      catchError(() => {
        this.outcome = 1n;
      });
      catchPanic((code) => {
        this.outcome = code === 0x12n ? 2n : 0n;
      });
      this.outcome = 3n;
    }
  }

  move(to: Address, amount: bigint): void {
    require(!this.entered, "reentered");
    this.entered = true;
    this.total = this.total + amount;
    emit(this.Moved(msg.sender, to, amount, TAG));
    this.entered = false;
  }
}

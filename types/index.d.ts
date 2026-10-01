declare module "scriipture" {
  /** What Solidity lets you read off an `address`. */
  export interface AddressMembers {
    /** Wei held by the account. */
    readonly balance: bigint;
    /** Deployed code (empty for an EOA): `a.code.length > 0n` tests for a contract. */
    readonly code: Bytes;
    readonly codehash: Bytes32;
    /**
     * Low-level call: `const [ok, data] = a.call({ value: v }, payload)` →
     * `(bool ok, bytes memory data) = a.call{value: v}(payload);`.
     * Check `ok`: an unchecked result is a `no-unchecked-low-level-call` finding.
     */
    call(options: { value?: bigint; gas?: bigint }, data: Bytes | string): [boolean, Bytes];
    call(data: Bytes | string): [boolean, Bytes];
    staticcall(data: Bytes | string): [boolean, Bytes];
    delegatecall(data: Bytes | string): [boolean, Bytes];
  }
  /** An address that can receive ether: what `payable(a)` returns. */
  export interface PayableAddress extends AddressMembers {
    transfer(amount: bigint): void;
    send(amount: bigint): boolean;
  }
  export type Address = string & AddressMembers & { readonly __brand: "Address" };
  export type CheckedAddress = Address & { readonly __checked: true };
  export type Bytes32 = string & { readonly __brand: "Bytes32" };
  export type Bytes = string & { readonly __brand: "Bytes" };

  /**
   * Fixed-width integers. `bigint` maps to `uint256`; annotate with one of these
   * to get the narrower Solidity type (e.g. `@storage votes: Uint64 = 0n as Uint64`).
   * Adjacent narrow state variables share a storage slot.
   */
  export type Uint8 = bigint & { readonly __brand: "Uint8" };
  export type Uint16 = bigint & { readonly __brand: "Uint16" };
  export type Uint24 = bigint & { readonly __brand: "Uint24" };
  export type Uint32 = bigint & { readonly __brand: "Uint32" };
  export type Uint40 = bigint & { readonly __brand: "Uint40" };
  export type Uint48 = bigint & { readonly __brand: "Uint48" };
  export type Uint56 = bigint & { readonly __brand: "Uint56" };
  export type Uint64 = bigint & { readonly __brand: "Uint64" };
  export type Uint72 = bigint & { readonly __brand: "Uint72" };
  export type Uint80 = bigint & { readonly __brand: "Uint80" };
  export type Uint88 = bigint & { readonly __brand: "Uint88" };
  export type Uint96 = bigint & { readonly __brand: "Uint96" };
  export type Uint104 = bigint & { readonly __brand: "Uint104" };
  export type Uint112 = bigint & { readonly __brand: "Uint112" };
  export type Uint120 = bigint & { readonly __brand: "Uint120" };
  export type Uint128 = bigint & { readonly __brand: "Uint128" };
  export type Uint136 = bigint & { readonly __brand: "Uint136" };
  export type Uint144 = bigint & { readonly __brand: "Uint144" };
  export type Uint152 = bigint & { readonly __brand: "Uint152" };
  export type Uint160 = bigint & { readonly __brand: "Uint160" };
  export type Uint168 = bigint & { readonly __brand: "Uint168" };
  export type Uint176 = bigint & { readonly __brand: "Uint176" };
  export type Uint184 = bigint & { readonly __brand: "Uint184" };
  export type Uint192 = bigint & { readonly __brand: "Uint192" };
  export type Uint200 = bigint & { readonly __brand: "Uint200" };
  export type Uint208 = bigint & { readonly __brand: "Uint208" };
  export type Uint216 = bigint & { readonly __brand: "Uint216" };
  export type Uint224 = bigint & { readonly __brand: "Uint224" };
  export type Uint232 = bigint & { readonly __brand: "Uint232" };
  export type Uint240 = bigint & { readonly __brand: "Uint240" };
  export type Uint248 = bigint & { readonly __brand: "Uint248" };
  export type Uint256 = bigint & { readonly __brand: "Uint256" };
  export type Int8 = bigint & { readonly __brand: "Int8" };
  export type Int16 = bigint & { readonly __brand: "Int16" };
  export type Int24 = bigint & { readonly __brand: "Int24" };
  export type Int32 = bigint & { readonly __brand: "Int32" };
  export type Int40 = bigint & { readonly __brand: "Int40" };
  export type Int48 = bigint & { readonly __brand: "Int48" };
  export type Int56 = bigint & { readonly __brand: "Int56" };
  export type Int64 = bigint & { readonly __brand: "Int64" };
  export type Int72 = bigint & { readonly __brand: "Int72" };
  export type Int80 = bigint & { readonly __brand: "Int80" };
  export type Int88 = bigint & { readonly __brand: "Int88" };
  export type Int96 = bigint & { readonly __brand: "Int96" };
  export type Int104 = bigint & { readonly __brand: "Int104" };
  export type Int112 = bigint & { readonly __brand: "Int112" };
  export type Int120 = bigint & { readonly __brand: "Int120" };
  export type Int128 = bigint & { readonly __brand: "Int128" };
  export type Int136 = bigint & { readonly __brand: "Int136" };
  export type Int144 = bigint & { readonly __brand: "Int144" };
  export type Int152 = bigint & { readonly __brand: "Int152" };
  export type Int160 = bigint & { readonly __brand: "Int160" };
  export type Int168 = bigint & { readonly __brand: "Int168" };
  export type Int176 = bigint & { readonly __brand: "Int176" };
  export type Int184 = bigint & { readonly __brand: "Int184" };
  export type Int192 = bigint & { readonly __brand: "Int192" };
  export type Int200 = bigint & { readonly __brand: "Int200" };
  export type Int208 = bigint & { readonly __brand: "Int208" };
  export type Int216 = bigint & { readonly __brand: "Int216" };
  export type Int224 = bigint & { readonly __brand: "Int224" };
  export type Int232 = bigint & { readonly __brand: "Int232" };
  export type Int240 = bigint & { readonly __brand: "Int240" };
  export type Int248 = bigint & { readonly __brand: "Int248" };
  export type Int256 = bigint & { readonly __brand: "Int256" };
  /** Fixed-size byte arrays `bytes1` … `bytes31`; `Bytes32` is declared above. */
  export type Bytes1 = string & { readonly __brand: "Bytes1" };
  export type Bytes2 = string & { readonly __brand: "Bytes2" };
  export type Bytes3 = string & { readonly __brand: "Bytes3" };
  export type Bytes4 = string & { readonly __brand: "Bytes4" };
  export type Bytes5 = string & { readonly __brand: "Bytes5" };
  export type Bytes6 = string & { readonly __brand: "Bytes6" };
  export type Bytes7 = string & { readonly __brand: "Bytes7" };
  export type Bytes8 = string & { readonly __brand: "Bytes8" };
  export type Bytes9 = string & { readonly __brand: "Bytes9" };
  export type Bytes10 = string & { readonly __brand: "Bytes10" };
  export type Bytes11 = string & { readonly __brand: "Bytes11" };
  export type Bytes12 = string & { readonly __brand: "Bytes12" };
  export type Bytes13 = string & { readonly __brand: "Bytes13" };
  export type Bytes14 = string & { readonly __brand: "Bytes14" };
  export type Bytes15 = string & { readonly __brand: "Bytes15" };
  export type Bytes16 = string & { readonly __brand: "Bytes16" };
  export type Bytes17 = string & { readonly __brand: "Bytes17" };
  export type Bytes18 = string & { readonly __brand: "Bytes18" };
  export type Bytes19 = string & { readonly __brand: "Bytes19" };
  export type Bytes20 = string & { readonly __brand: "Bytes20" };
  export type Bytes21 = string & { readonly __brand: "Bytes21" };
  export type Bytes22 = string & { readonly __brand: "Bytes22" };
  export type Bytes23 = string & { readonly __brand: "Bytes23" };
  export type Bytes24 = string & { readonly __brand: "Bytes24" };
  export type Bytes25 = string & { readonly __brand: "Bytes25" };
  export type Bytes26 = string & { readonly __brand: "Bytes26" };
  export type Bytes27 = string & { readonly __brand: "Bytes27" };
  export type Bytes28 = string & { readonly __brand: "Bytes28" };
  export type Bytes29 = string & { readonly __brand: "Bytes29" };
  export type Bytes30 = string & { readonly __brand: "Bytes30" };
  export type Bytes31 = string & { readonly __brand: "Bytes31" };

  export const msg: {
    sender: CheckedAddress;
    value: bigint;
    data: Bytes;
    /** The first four bytes of calldata: the function selector. */
    sig: Bytes4;
  };

  export const block: {
    timestamp: bigint;
    number: bigint;
    coinbase: Address;
    chainid: bigint;
    basefee: bigint;
    blobbasefee: bigint;
    prevrandao: bigint;
    gaslimit: bigint;
  };

  export const tx: {
    /** The EOA that started the transaction. Never use it for authorization: the `no-tx-origin` rule flags it. */
    origin: Address;
    gasprice: bigint;
  };

  /** Ether and time units. `2n * ether` emits `2 ether`; `7n * days` emits `7 days`. */
  export const wei: bigint;
  export const gwei: bigint;
  export const ether: bigint;
  export const seconds: bigint;
  export const minutes: bigint;
  export const hours: bigint;
  export const days: bigint;
  export const weeks: bigint;

  /** `address(this)` is the contract's own address; `address(0n)` the zero address. */
  export function address(value: object | bigint | Bytes): Address;
  /**
   * The contract or interface at an address, typed: `at<IERC20>(token).transfer(to, v)`
   * → `IERC20(token).transfer(to, v)`. `IERC20` is a file-level TS interface
   * (or a contract class) in the same build.
   */
  export function at<T>(addr: Address): T;
  /**
   * Solidity's `type(T)`: `type<Uint64>().max` → `type(uint64).max`,
   * `type<IERC20>().interfaceId` → `type(IERC20).interfaceId`.
   */
  export function type<T>(): {
    readonly max: T;
    readonly min: T;
    readonly interfaceId: Bytes4;
    readonly name: string;
    readonly creationCode: Bytes;
    readonly runtimeCode: Bytes;
  };

  /** Remaining gas. */
  export function gasleft(): bigint;
  /** Hash of one of the 256 most recent blocks, else zero. */
  export function blockhash(blockNumber: bigint): Bytes32;
  /** Panics (0x01) when false. For invariants that must never fail; use `require` for input checks. */
  export function assert(condition: boolean): void;
  export function addmod(x: bigint, y: bigint, k: bigint): bigint;
  export function mulmod(x: bigint, y: bigint, k: bigint): bigint;
  export function ripemd160(data: Bytes): Bytes;

  /**
   * Solidity's `unchecked { … }`: arithmetic inside wraps instead of reverting.
   * `unchecked(() => { i = i + 1n; })`. Only when overflow is provably impossible.
   */
  export function unchecked(block: () => void): void;

  /**
   * A fixed-size array: `FixedArray<bigint, 3>` → `uint256[3]`.
   */
  export type FixedArray<T, N extends number> = T[] & { readonly length: N };

  /**
   * A user-defined value type: `type Price = ValueType<Uint128, "Price">` →
   * `type Price is uint128;`. Like Solidity's, it is opaque -- no arithmetic,
   * and no mixing with the type it wraps -- until converted with `wrap` /
   * `unwrap`. The string must be the alias's own name.
   */
  export type ValueType<T, Name extends string> = { readonly __valueType: Name; readonly __underlying: T };
  /** The type a `ValueType` wraps. */
  export type UnderlyingOf<V> = V extends ValueType<infer U, string> ? U : never;
  /** `wrap<Price>(x)` → `Price.wrap(x)`. The value type must be written. */
  export function wrap<V extends ValueType<unknown, string>>(value: UnderlyingOf<V>): V;
  /** `unwrap(p)` → `Price.unwrap(p)`. */
  export function unwrap<V extends ValueType<unknown, string>>(value: V): UnderlyingOf<V>;

  /**
   * Function types. A TS function type is an `internal` Solidity one:
   * `(a: bigint) => boolean` → `function (uint256) internal returns (bool)`.
   * These markers adjust it and are otherwise the function type itself:
   * `External<F>` → `external` (e.g. `at<I>(a).f` as a callback),
   * `View<F>` / `Pure<F>` / `Payable<F>` → its mutability. A function that takes
   * or returns an internal one is `internal` itself unless marked otherwise.
   */
  export type External<F extends (...args: any[]) => any> = F;
  export type View<F extends (...args: any[]) => any> = F;
  export type Pure<F extends (...args: any[]) => any> = F;
  export type Payable<F extends (...args: any[]) => any> = F;

  /**
   * Deploys a contract with CREATE2 (`salt`) and / or ether for its
   * constructor (`value`, which needs a `/** @payable *\/` constructor):
   * `create(Child, { salt: s, value: v }, a)` → `new Child{salt: s, value: v}(a)`.
   */
  export function create<C extends abstract new (...args: any[]) => any>(
    contract: C,
    options: { salt?: Bytes32; value?: bigint },
    ...args: ConstructorParameters<C>
  ): InstanceType<C>;

  /**
   * In a `catch` block: the clause for a revert with a reason string,
   * `catch Error(string memory reason) { … }`. The rest of the block is the
   * catch-all; leave it empty (and the `catch` unbound) to let any other
   * failure revert.
   */
  export function catchError(handler: (reason: string) => void): void;
  /** In a `catch` block: the clause for a panic, `catch Panic(uint256 code) { … }` (0x11 overflow, 0x12 division by zero, …). */
  export function catchPanic(handler: (code: bigint) => void): void;

  /**
   * On a class: makes it a Solidity `library`. Its methods are `static` and
   * `internal` unless marked, so they are inlined into the contracts that
   * call them; `static readonly X = …` declares a library constant.
   */
  export function library(target: Function): void;
  /** On a class: `@using(Lib)` → `using Lib for *;`, `@using<bigint>(Lib)` → `using Lib for uint256;`. */
  export function using<T = unknown>(lib: Function): (target: Function) => void;
  /**
   * Gives a method the Solidity name of another, so two functions can share
   * one: `@overload("transfer") transferWithData(to, v, data)` → `function transfer(…)`.
   * Calls by the TS name are emitted under the Solidity one.
   */
  export function overload(name: string): any;
  /** On a state variable: EIP-1153 transient storage, `bool transient locked;`. Reset at the end of every transaction. */
  export function transient(...args: any[]): any;

  export function validate(addr: Address): CheckedAddress;

  export function storage(...args: any[]): any;
  export function view(...args: any[]): any;
  export function pure(...args: any[]): any;
  /** On a method: `payable`. On an address: `payable(a)`, which can receive ether. */
  export function payable(a: Address): PayableAddress;
  export function payable(target: object, key: string | symbol, descriptor?: PropertyDescriptor): any;
  /**
   * Declares a Solidity `modifier`. Apply it with a decorator of the same name:
   *
   *   @modifier onlyAdmin(): void { require(msg.sender === this.admin); }
   *   @onlyAdmin setFee(f: bigint): void { … }
   *
   * The wrapped function runs at `_;`, or after the body when `_` is not written.
   * TypeScript needs the applied name in scope: `declare const onlyAdmin: MethodDecorator;`
   * (or `(x: bigint) => MethodDecorator` for a modifier with arguments).
   */
  export function modifier(...args: any[]): any;
  /**
   * Passes one of the decorated function's own parameters to a modifier:
   * `@onlyCreator(param("id")) claim(id: bigint)` → `function claim(uint256 id) … onlyCreator(id)`.
   * Needed because TypeScript evaluates decorator arguments before any call.
   */
  export function param(name: string): any;
  /** Inside a `@modifier`: where the wrapped function's body runs (`_;`). */
  export const _: void;
  /** Marks a function `virtual` so a contract outside this build can override it. Overrides within the build are inferred. */
  export function virtual(...args: any[]): any;
  export function onlyOwner(...args: any[]): any;
  export function nonReentrant(...args: any[]): any;
  export function whenNotPaused(...args: any[]): any;
  export function assembly(...args: any[]): any;
  /**
   * Visibility. Without one a function is `public`. `@external` also lets the optimizer pass reference-type parameters in calldata.
   * `public` and `private` are reserved words in TypeScript, so those two carry a trailing underscore; they emit as `public` / `private`.
   */
  export function external(...args: any[]): any;
  export function public_(...args: any[]): any;
  export function internal(...args: any[]): any;
  export function private_(...args: any[]): any;
  export function solidity(strings: TemplateStringsArray, ...values: any[]): any;
  export function yul(strings: TemplateStringsArray, ...values: any[]): any;

  export function invariant(...args: any[]): any;
  export function unsafe(justification: string): any;
  export function allowTxOrigin(justification: string): any;
  export function allowSelfdestruct(justification: string): any;
  export function allowZeroAddress(justification: string): any;
  export function allowLowLevelCall(justification: string): any;
  export function throws(...errorNames: string[]): any;

  export function require(condition: boolean, message?: string): void;
  export function revert(message?: string): never;
  export function emit(...args: any[]): void;

  /**
   * Marks an event parameter as indexed (max 3 per event). A marker the
   * transpiler reads by name; to TypeScript it is just `T`, so a plain value
   * can be passed for it (a branded `T & {…}` made every indexed event
   * impossible to emit without a cast).
   */
  export type Indexed<T> = T;
  /**
   * Declares a Solidity event. The method body is ignored.
   * `@event({ anonymous: true })` → `event E(…) anonymous;` (no signature topic, up to 4 indexed).
   */
  export function event(...args: any[]): any;
  /** Declares a Solidity custom error. The method body is ignored. */
  export function error(...args: any[]): any;

  export function pullPayment(recipient: CheckedAddress, amount: bigint): void;

  export function keccak256(data: any): Bytes32;
  export function sha256(data: any): Bytes32;
  export function ecrecover(hash: Bytes32, v: number, r: Bytes32, s: Bytes32): Address;

  export const abi: {
    encode(...args: any[]): Bytes;
    encodePacked(...args: any[]): Bytes;
    encodeWithSelector(selector: Bytes4, ...args: any[]): Bytes;
    encodeWithSignature(signature: string, ...args: any[]): Bytes;
    /**
     * `abi.decode<[bigint, Address]>(data)` → `abi.decode(data, (uint256, address))`.
     * Destructure the result: `const [amount, to] = abi.decode<[bigint, Address]>(data);`.
     */
    decode<T>(data: Bytes): T;
  };
}

declare module "scriipture" {
  export type Address = string & { readonly __brand: "Address" };
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
    data: string;
  };

  export const block: {
    timestamp: bigint;
    number: bigint;
    coinbase: Address;
    chainid: bigint;
  };

  export function validate(addr: Address): CheckedAddress;

  export function storage(...args: any[]): any;
  export function view(...args: any[]): any;
  export function pure(...args: any[]): any;
  export function payable(...args: any[]): any;
  export function onlyOwner(...args: any[]): any;
  export function nonReentrant(...args: any[]): any;
  export function whenNotPaused(...args: any[]): any;
  export function assembly(...args: any[]): any;
  /** Visibility. Without one a function is `public`. `@external` also lets the optimizer pass reference-type parameters in calldata. */
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

  /** Marks an event parameter as indexed (max 3 per event). */
  export type Indexed<T> = T & { readonly __indexed: unique symbol };
  /** Declares a Solidity event. The method body is ignored. */
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
    encodeWithSelector(selector: Bytes32, ...args: any[]): Bytes;
  };
}

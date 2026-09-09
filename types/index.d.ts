declare module "scriipture" {
  export type Address = string & { readonly __brand: "Address" };
  export type CheckedAddress = Address & { readonly __checked: true };
  export type Bytes32 = string & { readonly __brand: "Bytes32" };
  export type Bytes = string & { readonly __brand: "Bytes" };

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

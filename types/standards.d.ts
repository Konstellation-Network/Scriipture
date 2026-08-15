declare module "scriipture/standards" {
  import type { Address } from "scriipture";

  export class ERC20 {
    constructor(name: string, symbol: string);
    totalSupply(): bigint;
    balanceOf(account: Address): bigint;
    transfer(to: Address, amount: bigint): boolean;
    allowance(owner: Address, spender: Address): bigint;
    approve(spender: Address, amount: bigint): boolean;
    transferFrom(from: Address, to: Address, amount: bigint): boolean;
    _mint(to: Address, amount: bigint): void;
    _burn(from: Address, amount: bigint): void;
  }

  export class ERC721 {
    constructor(name: string, symbol: string);
    ownerOf(tokenId: bigint): Address;
    balanceOf(owner: Address): bigint;
  }
}

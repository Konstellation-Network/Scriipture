declare module "forge-std" {
  import type { Address } from "scriipture";

  export class Test {
    constructor();
  }
}

declare const vm: {
  startPrank(account: import("scriipture").Address): void;
  stopPrank(): void;
  expectRevert(): void;
  expectRevert(selector: string): void;
  deal(account: import("scriipture").Address, value: bigint): void;
  warp(timestamp: bigint): void;
  roll(block: bigint): void;
  addr(privateKey: bigint): import("scriipture").Address;
};

declare function assertEq(a: bigint, b: bigint): void;
declare function assertEq(a: boolean, b: boolean): void;
declare function assertEq(a: import("scriipture").Address, b: import("scriipture").Address): void;
declare function assertEq(a: string, b: string): void;
declare function assertTrue(condition: boolean): void;
declare function assertFalse(condition: boolean): void;
declare function assertGt(a: bigint, b: bigint): void;
declare function assertLt(a: bigint, b: bigint): void;

import { Address, msg } from "scriipture";
import { Test } from "forge-std";
import { MyToken } from "../../examples/erc20-token/MyToken";

export class MyTokenTest extends Test {
  myToken!: MyToken;

  setUp(): void {
    this.myToken = new MyToken(1000000n);
  }

  testInitialSupplyMatches(): void {
    assertEq(this.myToken.totalSupply(), 1000000n);
  }

  testNameAndSymbol(): void {
    assertEq(this.myToken.name() as unknown as string, "MyToken");
    assertEq(this.myToken.symbol() as unknown as string, "MTK");
  }

  testNonOwnerCannotMint(): void {
    const alice: Address = vm.addr(0x1234n);
    vm.startPrank(alice);
    vm.expectRevert();
    this.myToken.mint(alice, 100n);
    vm.stopPrank();
  }
}

declare const tx: { origin: Address };

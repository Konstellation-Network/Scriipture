import { Address, onlyOwner, msg } from "scriipture";
import { ERC20 } from "scriipture/standards";

export class MyToken extends ERC20 {
  constructor(initialSupply: bigint) {
    super("MyToken", "MTK");
    this._mint(msg.sender, initialSupply);
  }

  @onlyOwner
  mint(to: Address, amount: bigint): void {
    this._mint(to, amount);
  }
}

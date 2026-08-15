import { storage, onlyOwner, Address, msg } from "scriipture";

export class RequireToError {
  @storage value: bigint = 0n;

  @onlyOwner
  setValue(v: bigint): void {
    require(v > 0n, "Value must be positive");
    this.value = v;
  }
}

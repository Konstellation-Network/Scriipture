import { assembly, yul } from "scriipture";

export class AsmAdd {
  add(a: bigint, b: bigint): bigint {
    return a + b;
  }

  @assembly
  addUnchecked(a: bigint, b: bigint): bigint {
    return yul`
      let r := add(a, b)
      mstore(0x0, r)
      return(0x0, 0x20)
    ` as unknown as bigint;
  }
}

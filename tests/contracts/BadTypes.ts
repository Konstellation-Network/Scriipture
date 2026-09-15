import { storage, Uint7 } from "scriipture";

export enum Level { Low = 1, High = 2 }

export class BadTypes {
  @storage width: Uint7 = 0n as Uint7;

  make(): void {
    const x = { a: 1n };
  }
}

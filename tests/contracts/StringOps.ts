import { storage, view, external } from "scriipture";

export class StringOps {
  @storage name: string = "a";

  @external
  @view
  same(other: string): boolean {
    return this.name === other;
  }

  @external
  @view
  different(other: string): boolean {
    return this.name !== other;
  }

  rename(suffix: string): void {
    this.name = this.name + suffix;
  }

  append(extra: string): void {
    this.name += extra;
  }

  @external
  @view
  isNamed(): boolean {
    return this.name === "abc";
  }
}

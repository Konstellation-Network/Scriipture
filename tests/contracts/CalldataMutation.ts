import { storage, external } from "scriipture";

export class CalldataMutation {
  @storage total: bigint = 0n;

  // A push through an index is still a write to `rows`.
  @external
  addRow(rows: Array<Array<bigint>>): void {
    rows[0].push(1n);
    this.total = this.total + 1n;
  }

  // Assignment through a member of an element.
  @external
  touch(words: Array<string>): void {
    words[0] = "x";
    this.total = this.total + 1n;
  }
}

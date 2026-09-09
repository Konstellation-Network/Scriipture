/**
 * Identifiers that are legal in TypeScript but cannot be used as identifiers in
 * Solidity. Emitting one produces code solc rejects with "Expected identifier
 * but got reserved keyword", pointing at generated .sol rather than the user's
 * source -- so we catch it at validate time instead.
 *
 * The list was derived empirically: each candidate was compiled as
 * `uint256 public <name>;` against solc 0.8.30, and only the names solc
 * actually rejects are listed here. Built-in globals that Solidity permits
 * shadowing (msg, block, tx, abi, require, revert, keccak256, ...) compile
 * fine and are deliberately absent.
 */

const KEYWORDS = [
  // current keywords
  "abstract", "anonymous", "as", "assembly", "break", "case", "catch", "constant",
  "constructor", "continue", "contract", "default", "delete", "do", "else", "emit",
  "enum", "event", "external", "fallback", "for", "function", "hex", "if", "immutable",
  "import", "indexed", "interface", "internal", "is", "library", "mapping", "memory",
  "modifier", "new", "override", "payable", "pragma", "private", "public", "pure",
  "receive", "return", "returns", "storage", "string", "struct", "throw", "try",
  "type", "unchecked", "using", "view", "virtual", "while", "true", "false",
  "this", "super",

  // reserved for future use -- the dangerous group, since these read as
  // ordinary domain vocabulary
  "after", "alias", "apply", "auto", "byte", "copyof", "define", "final",
  "implements", "in", "inline", "let", "macro", "match", "mutable", "null", "of",
  "partial", "promise", "reference", "relocatable", "sealed", "sizeof", "static",
  "supports", "switch", "typedef", "typeof", "var",

  // elementary type names
  "address", "bool", "bytes", "int", "uint", "fixed", "ufixed",

  // denominations
  "wei", "gwei", "ether", "seconds", "minutes", "hours", "days", "weeks", "years",
];

function sizedTypeNames(): string[] {
  const out: string[] = [];
  for (let i = 8; i <= 256; i += 8) {
    out.push(`int${i}`, `uint${i}`);
  }
  for (let i = 1; i <= 32; i++) out.push(`bytes${i}`);
  for (const m of [8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96, 104, 112, 120, 128,
                   136, 144, 152, 160, 168, 176, 184, 192, 200, 208, 216, 224, 232, 240, 248, 256]) {
    // N is any integer 0..80, not just multiples of 8
    for (let n = 0; n <= 80; n++) {
      out.push(`fixed${m}x${n}`, `ufixed${m}x${n}`);
    }
  }
  return out;
}

export const SOLIDITY_RESERVED = new Set<string>([...KEYWORDS, ...sizedTypeNames()]);

export function isSolidityReserved(name: string): boolean {
  return SOLIDITY_RESERVED.has(name);
}

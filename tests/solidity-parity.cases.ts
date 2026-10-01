/**
 * One case per Solidity language feature, written the way a TypeScript
 * developer coming from Solidity would write it. tests/solidity-parity.test.ts
 * runs each through the real build pipeline (parse, validate, optimize, emit)
 * and solc, and checks the emitted Solidity says what the TypeScript said.
 *
 * Grouped by the Solidity docs' sections: types, literals, globals,
 * conversions, functions, errors and control flow, events, contracts, ABI,
 * state modifiers, operators.
 */
export interface ParityCase {
  id: string;
  feature: string;
  src: string;
  /** Patterns the emitted Solidity must contain. */
  expect?: RegExp[];
}

export const PARITY_CASES: ParityCase[] = [
  { id: "t_uint_widths", feature: "uint8/int256 narrow ints", src: `
export class C { @storage a: Uint8 = 1n as Uint8; @storage b: Int256 = 0n as Int256;
  f(x: Int8): Int256 { return (x as bigint) as Int256; } }` },
  { id: "t_signed_neg", feature: "signed negation / negative literal", src: `
export class C { @storage b: Int256 = -5n as Int256;
  @pure neg(x: Int256): Int256 { return -x as Int256; } }`, expect: [/int256 public b = -5;/, /return -x;/] },
  { id: "t_bytes32", feature: "bytes32 / bytes4 values", src: `
export class C { @storage h: Bytes32; @storage sel: Bytes4;
  set(x: Bytes32): void { this.h = x; } }` },
  { id: "t_fixed_array", feature: "fixed-size array FixedArray<T, N>", src: `
export class C { @storage slots: FixedArray<bigint, 3>;
  @view get(i: bigint): bigint { return this.slots[i]; } }`, expect: [/uint256\[3\] public slots;/] },
  { id: "t_nested_mapping", feature: "nested mapping (allowances)", src: `
export class C { @storage allow: Map<Address, Map<Address, bigint>> = new Map();
  approve(s: Address, v: bigint): void { this.allow.get(msg.sender)!.set(s, v); }
  @view allowance(o: Address, s: Address): bigint { return this.allow.get(o)!.get(s)!; } }`,
    expect: [/allow\[msg\.sender\]\[s\] = v/, /return allow\[o\]\[s\];/] },
  { id: "t_array_struct", feature: "dynamic array of structs, push/pop/length", src: `
interface Item { id: bigint; owner: Address; }
export class C { @storage items: Item[] = [];
  add(id: bigint): void { this.items.push({ id, owner: msg.sender }); }
  pop(): void { this.items.pop(); }
  @view count(): bigint { return BigInt(this.items.length); } }`,
    expect: [/items\.push\(Item\(\{id: id, owner: msg\.sender\}\)\)/, /items\.pop\(\)/] },
  { id: "t_memory_array", feature: "memory array: new Array<T>(n)", src: `
export class C { @pure make(n: bigint): bigint[] { const xs: bigint[] = new Array<bigint>(n); xs[0] = 1n; return xs; } }`,
    expect: [/new uint256\[\]\(n\)/] },
  { id: "t_address_payable", feature: "address payable / payable(x).transfer", src: `
export class C { @payable deposit(): void {}
  pay(to: CheckedAddress, v: bigint): void { payable(to).transfer(v); } }`, expect: [/payable\(to\)\.transfer\(v\)/] },
  { id: "l_hex_number", feature: "hex number literal 0xff", src: `
export class C { @storage mask: bigint = 0xffn; @pure m(x: bigint): bigint { return x & 0xFFn; } }`, expect: [/= 0xff;|= 255;/, /& (0xff|0xFF|255)/] },
  { id: "l_underscores", feature: "numeric separators 1_000_000n", src: `
export class C { @storage cap: bigint = 1_000_000n; }`, expect: [/(1_000_000|1000000);/] },
  { id: "l_units", feature: "ether/gwei/days units", src: `
import { ether, days } from "scriipture";
export class C { @storage minDep: bigint = 1n * ether; @storage lock: bigint = 7n * days; }`, expect: [/1 ether|1e18|1000000000000000000/, /7 days|604800/] },
  { id: "l_sci", feature: "10n ** 18n exponent", src: `
export class C { @storage one: bigint = 10n ** 18n; }`, expect: [/10 \*\* 18/] },
  { id: "l_hex_string", feature: "hex literal cast to bytesN", src: `
export class C { @storage magic: Bytes4 = "0xdeadbeef" as Bytes4; }`, expect: [/bytes4 public magic = 0xdeadbeef;|hex"deadbeef"/] },
  { id: "l_number_literal", feature: "number (not bigint) literal & number params", src: `
export class C { @storage n: number = 5; inc(by: number): void { this.n += by; } }` },

  // ───────────── Globals ─────────────
  { id: "g_msg", feature: "msg.sender/value/data/sig", src: `
export class C { @storage last: Address; @payable f(): void { this.last = msg.sender; require(msg.value > 0n); } @view s(): Bytes4 { return msg.sig; } }`, expect: [/msg\.sig/] },
  { id: "g_block", feature: "block.timestamp/number/chainid/basefee/prevrandao/gaslimit", src: `
export class C { @view f(): bigint { return block.timestamp + block.number + block.chainid + block.basefee + block.prevrandao + block.gaslimit; } }` },
  { id: "g_tx", feature: "tx.gasprice", src: `
export class C { @view f(): bigint { return tx.gasprice; } }` },
  { id: "g_this_balance", feature: "address(this).balance", src: `
import { address } from "scriipture";
export class C { @view bal(): bigint { return address(this).balance; } }`, expect: [/address\(this\)\.balance/] },
  { id: "g_this_addr", feature: "this.address → address(this)", src: `
export class C { @view me(): Address { return this.address; } }`, expect: [/address\(this\)/] },
  { id: "g_gasleft", feature: "gasleft()", src: `
import { gasleft } from "scriipture";
export class C { @view g(): bigint { return gasleft(); } }` },
  { id: "g_code", feature: "addr.code.length", src: `
export class C { @view isContract(a: Address): boolean { return a.code.length > 0n; } }` },
  { id: "g_blockhash", feature: "blockhash(n)", src: `
import { blockhash } from "scriipture";
export class C { @view h(n: bigint): Bytes32 { return blockhash(n); } }` },

  // ───────────── Conversions ─────────────
  { id: "c_cast_narrow", feature: "explicit narrowing conversion uint8(x)", src: `
import { uint8 } from "scriipture";
export class C { @pure f(x: bigint): Uint8 { return uint8(x); } }`, expect: [/uint8\(x\)/] },
  { id: "c_as_cast", feature: "x as Uint8 on a non-literal → uint8(x)", src: `
export class C { @pure f(x: bigint): Uint8 { return x as Uint8; } }`, expect: [/uint8\(x\)/] },
  { id: "c_type_max", feature: "type<T>().max / .min", src: `
import { type } from "scriipture";
export class C { @storage m: bigint = type<Uint256>().max; @view lo(): Int8 { return type<Int8>().min; } }`, expect: [/type\(uint256\)\.max/, /type\(int8\)\.min/] },
  { id: "c_enum_to_uint", feature: "BigInt(enum) → uint256(e)", src: `
enum S { A, B }
export class C { @storage s: S = S.A; @view n(): bigint { return BigInt(this.s); } }`, expect: [/uint256\(s\)/] },

  // ───────────── Functions ─────────────
  { id: "f_tuple_return", feature: "multiple return values", src: `
export class C { @pure pair(a: bigint): [bigint, boolean] { return [a, true]; }
  @pure use(): bigint { const [x, ok] = this.pair(1n); return ok ? x : 0n; }
  @pure swap(a: bigint, b: bigint): [bigint, bigint] { [a, b] = [b, a]; return [a, b]; } }`, expect: [/returns \(uint256, bool\)/, /return \(a, true\);/, /\(uint256 x, bool ok\) = pair\(1\);/, /\(a, b\) = \(b, a\);/] },
  { id: "f_receive", feature: "receive() external payable", src: `
export class C { @storage total: bigint = 0n; @payable receive(): void { this.total += msg.value; } }`, expect: [/receive\(\) external payable/] },
  { id: "f_fallback", feature: "fallback() external", src: `
export class C { @storage hits: bigint = 0n; fallback(): void { this.hits += 1n; } }`, expect: [/fallback\(\) external/] },
  { id: "f_modifier_real", feature: "custom modifier declared and applied, with args and _", src: `
import { modifier, _ } from "scriipture";
export class C { @storage admin: Address; @storage locked: boolean = false; @storage n: bigint = 0n;
  @modifier onlyAdmin(): void { require(msg.sender === this.admin, "not admin"); }
  @modifier atLeast(x: bigint): void { require(x > 0n); _; this.locked = false; }
  @onlyAdmin @atLeast(1n) doit(): void { this.n += 1n; } }`, expect: [/modifier onlyAdmin\(\) \{[\s\S]*?revert NotAdmin\(\);\n\s+\}\n\s+_;/, /modifier atLeast\(uint256 x\)/, /function doit\(\) public onlyAdmin atLeast\(1\)/] },
  { id: "f_modifier_param", feature: "modifier taking the function's own parameter: @m(param(\"id\"))", src: `
import { modifier, param } from "scriipture";
export class C { @storage owners: Map<bigint, Address> = new Map(); @storage n: bigint = 0n;
  @modifier onlyOwnerOf(id: bigint): void { require(msg.sender === this.owners.get(id)!); }
  @onlyOwnerOf(param("id")) bump(id: bigint): void { this.n += id; } }`, expect: [/function bump\(uint256 id\) public onlyOwnerOf\(id\)/] },
  { id: "f_private_field", feature: "@private_ state var visibility", src: `
import { private_ } from "scriipture";
export class C { @storage @private_ secret: bigint = 0n; set(v: bigint): void { this.secret = v; } }`, expect: [/uint256 private secret/] },
  { id: "f_virtual_override", feature: "virtual / override", src: `
export class Base { value(): bigint { return 1n; } }
export class Child extends Base { override value(): bigint { return 2n; } }`, expect: [/function value\(\) public virtual returns/, /function value\(\) public override returns/] },
  { id: "f_diamond_override", feature: "multiple inheritance override(A, B)", src: `
export class A { v(): bigint { return 1n; } }
export class B extends A { v(): bigint { return 2n; } }
export class C2 extends A { v(): bigint { return 3n; } }
export class D extends B, C2 { v(): bigint { return 4n; } }`, expect: [/override\(B, C2\)/] },
  { id: "f_abstract", feature: "abstract contract", src: `
export abstract class Base { abstract value(): bigint; twice(): bigint { return this.value() * 2n; } }
export class Impl extends Base { value(): bigint { return 3n; } }`, expect: [/abstract contract Base/] },
  { id: "f_internal_call", feature: "internal call this.helper()", src: `
export class C { private helper(x: bigint): bigint { return x * 2n; } f(x: bigint): bigint { return this.helper(x); } }`, expect: [/return helper\(x\);/] },
  { id: "f_named_param_call", feature: "calling a function with struct param", src: `
interface P { a: bigint; }
export class C { @storage s: bigint = 0n; take(p: P): void { this.s = p.a; } go(): void { this.take({ a: 1n }); } }` },

  // ───────────── Control flow / errors ─────────────
  { id: "e_assert", feature: "assert(cond)", src: `
import { assert } from "scriipture";
export class C { @storage x: bigint = 0n; f(): void { this.x += 1n; assert(this.x > 0n); } }`, expect: [/assert\(x > 0\)/] },
  { id: "e_require_custom", feature: "require(cond, CustomError())", src: `
export class C { @error Nope(a: bigint): void {} f(a: bigint): void { require(a > 0n, this.Nope(a)); } }` },
  { id: "e_revert_custom", feature: "revert(this.CustomError(args))", src: `
export class C { @error TooLow(have: bigint, want: bigint): void {}
  f(a: bigint): void { if (a < 10n) revert(this.TooLow(a, 10n)); } }`, expect: [/revert TooLow\(a, 10\);/] },
  { id: "e_revert_custom_bare", feature: "revert(TooLow(args)) bare name", src: `
export class C { @error TooLow(have: bigint): void {}
  f(a: bigint): void { if (a < 10n) revert(TooLow(a)); } }`, expect: [/revert TooLow\(a\);/] },
  { id: "e_throw_error", feature: "throw new Error(msg)", src: `
export class C { f(a: bigint): void { if (a === 0n) throw new Error("zero"); } }`, expect: [/revert\("zero"\)|revert Zero\(\)/] },
  { id: "e_throw_custom", feature: "throw new TooLow(a) / throw this.TooLow(a)", src: `
export class C { @error TooLow(a: bigint): void {}
  f(a: bigint): void { if (a === 0n) throw new TooLow(a); if (a === 1n) throw this.TooLow(a); } }`, expect: [/revert TooLow\(a\);[\s\S]*revert TooLow\(a\);/] },
  { id: "e_do_while", feature: "do … while", src: `
export class C { @pure f(n: bigint): bigint { let i = 0n; do { i++; } while (i < n); return i; } }`, expect: [/do \{[\s\S]*\} while \(i < n\);/] },
  { id: "e_try_catch", feature: "try/catch on external call", src: `
interface IToken { /** @view */ balanceOf(a: Address): bigint; }
export class C { @storage last: bigint = 0n;
  f(t: Address): bigint { try { return at<IToken>(t).balanceOf(msg.sender); } catch { return 0n; } }
  g(t: Address): void { try { const b = at<IToken>(t).balanceOf(msg.sender); this.last = b; } catch (e) { this.last = BigInt(e.length); } } }`,
    expect: [/try IToken\(t\)\.balanceOf\(msg\.sender\) returns \(uint256 __tryResult\)/, /returns \(uint256 b\)/, /catch \(bytes memory e\)/] },
  { id: "e_unchecked", feature: "unchecked { } block", src: `
import { unchecked } from "scriipture";
export class C { @pure f(a: bigint): bigint { let r = 0n; unchecked(() => { r = a + 1n; }); return r; } }`, expect: [/unchecked \{\n\s+r = a \+ 1;/] },

  // ───────────── Events ─────────────
  { id: "v_event", feature: "event + emit with indexed", src: `
export class C { @event Transfer(from: Indexed<Address>, to: Indexed<Address>, v: bigint): void {}
  f(to: Address, v: bigint): void { emit(this.Transfer(msg.sender, to, v)); } }`, expect: [/emit Transfer\(msg\.sender, to, v\);/] },
  { id: "v_event_bare", feature: "emit(Transfer(...)) bare", src: `
export class C { @event Transfer(from: Indexed<Address>, v: bigint): void {}
  f(v: bigint): void { emit(Transfer(msg.sender, v)); } }`, expect: [/emit Transfer\(msg\.sender, v\);/] },

  // ───────────── Contracts / external calls ─────────────
  { id: "x_interface_call", feature: "interface + typed external call IERC20(t).transfer", src: `
export interface IERC20 { transfer(to: Address, v: bigint): boolean; /** @view */ balanceOf(a: Address): bigint; }
export class C { pull(t: Address, to: Address, v: bigint): void { const ok = at<IERC20>(t).transfer(to, v); require(ok); }
  @view bal(t: Address): bigint { return at<IERC20>(t).balanceOf(msg.sender); } }`, expect: [/interface IERC20/, /function balanceOf\(address a\) external view returns \(uint256\);/, /bool ok = IERC20\(t\)\.transfer\(to, v\)/, /import "\.\/IERC20\.sol";/] },
  { id: "x_implements", feature: "class implements interface → is I", src: `
export interface ICounter { /** @view */ count(): bigint; }
export class C implements ICounter { @storage n: bigint = 0n; inc(): void { this.n++; } @view count(): bigint { return this.n; } }`, expect: [/contract C is ICounter/] },
  { id: "x_new_contract", feature: "new Child(args)", src: `
export class Child { @storage v: bigint; constructor(v: bigint) { this.v = v; } }
export class Factory { @storage last: Address; make(v: bigint): void { const c = new Child(v); this.last = address(c); } }`, expect: [/new Child\(v\)/] },
  { id: "x_low_level_call", feature: "addr.call{value}(data)", src: `
import { allowLowLevelCall } from "scriipture";
export class C { @allowLowLevelCall("x") send(to: CheckedAddress, v: bigint): void { const [ok] = to.call({ value: v }, ""); require(ok); } }`, expect: [/\.call\{value: v\}\(""\)/] },
  { id: "x_new_typed", feature: "const c = new Child(v); c.method()", src: `
export class Child { @storage v: bigint; constructor(v: bigint) { this.v = v; } @view get(): bigint { return this.v; } }
export class Factory { @storage last: bigint = 0n; make(v: bigint): void { const c = new Child(v); this.last = c.get(); } }`, expect: [/Child c = new Child\(v\);/, /import "\.\/Child\.sol";/] },
  { id: "x_multi_inherit", feature: "multiple inheritance via decorators (Ownable+ReentrancyGuard)", src: `
import { onlyOwner, nonReentrant } from "scriipture";
export class C { @storage x: bigint = 0n; @onlyOwner @nonReentrant f(): void { this.x += 1n; } }` },
  { id: "a_encode", feature: "abi.encode/encodePacked + keccak256", src: `
export class C { @pure h(a: bigint, b: Address): Bytes32 { return keccak256(abi.encodePacked(a, b)); } }` },
  { id: "a_decode", feature: "abi.decode<[T, U]>(data)", src: `
export class C { @pure d(data: Bytes): bigint { const [a, b] = abi.decode<[bigint, Address]>(data); return a; } }`, expect: [/\(uint256 a, address b\) = abi\.decode\(data, \(uint256, address\)\);/] },
  { id: "a_encode_sig", feature: "abi.encodeWithSignature", src: `
export class C { @pure e(a: bigint): Bytes { return abi.encodeWithSignature("f(uint256)", a); } }` },
  { id: "a_keccak_string", feature: "keccak256 of a string literal", src: `
export class C { @storage role: Bytes32 = keccak256("MINTER_ROLE"); }`, expect: [/keccak256\(("MINTER_ROLE"|bytes\("MINTER_ROLE"\))\)/] },

  // ───────────── State modifiers ─────────────
  { id: "s_constant", feature: "literal-initialised, never-written var → constant", src: `
export class C { @storage readonly MAX: bigint = 100n; @view m(): bigint { return this.MAX; } }`, expect: [/constant MAX = 100/] },
  { id: "s_immutable", feature: "var set only in the constructor → immutable", src: `
export class C { @storage readonly owner: Address; constructor() { this.owner = msg.sender; } }`, expect: [/immutable owner/] },
  { id: "s_string_ops", feature: "string compare + concat + length", src: `
export class C { @storage name: string = "a"; @view same(o: string): boolean { return this.name === o; } @view cat(o: string): string { return this.name + o; } @view len(): bigint { return BigInt(this.name.length); } }` },

  // ───────────── Operators ─────────────
  { id: "i_local_types", feature: "locals typed from builtins (keccak, comparisons, abi)", src: `
export class C { @pure f(a: bigint, b: bigint): boolean { const h = keccak256(abi.encode(a)); const big = a > b; const enc = abi.encode(a); return big && h != keccak256(enc); } }`, expect: [/bytes32 h = keccak256/, /bool big = a > b;/, /bytes memory enc = abi\.encode\(a\);/] },
  { id: "s_increment_only", feature: "state var only ever ++'d is not made constant", src: `
export class C { @storage count: bigint = 0n; bump(): void { this.count++; } }`, expect: [/uint256 public count;/] },
  { id: "s_immutable_string", feature: "string set only in ctor is not made immutable", src: `
export class C { @storage name: string; constructor(n: string) { this.name = n; } }`, expect: [/string public name;/] },
  { id: "s_derived_writes_base", feature: "base var written only by derived stays mutable", src: `
export class Base { @storage limit: bigint = 10n; }
export class Child extends Base { raise(): void { this.limit = 20n; } }` },
  { id: "o_bitnot", feature: "~x bitwise not", src: `
export class C { @pure f(x: bigint): bigint { return ~x; } }`, expect: [/~x/] },
  { id: "o_compound", feature: "compound ops & shifts", src: `
export class C { @storage x: bigint = 1n; f(): void { this.x <<= 2n; this.x |= 1n; this.x **= 2n; } }` },
  { id: "o_ternary_chain", feature: "nested ternary & logical", src: `
export class C { @pure f(a: bigint): bigint { return a > 10n ? 2n : a > 5n ? 1n : 0n; } }`, expect: [/a > 10 \? 2 : \(?a > 5 \? 1 : 0\)?/] },
  { id: "o_precedence", feature: "parenthesised precedence preserved", src: `
export class C { @pure f(a: bigint, b: bigint): bigint { return (a + b) * 2n; } }`, expect: [/\(a \+ b\) \* 2/] },
  { id: "o_not_on_group", feature: "!(a && b)", src: `
export class C { @pure f(a: boolean, b: boolean): boolean { return !(a && b); } }`, expect: [/!\(a && b\)/] },
];

/** The features that need more than a class; tests/contracts/Advanced.ts uses them together. */
PARITY_CASES.push(
  { id: "x_library", feature: "@library with using … for", src: `
@library export class L { @pure static twice(a: bigint): bigint { return a * 2n; } }
@using<bigint>(L) export class C { @pure f(a: bigint): bigint { return L.twice(a); } }`,
    expect: [/library L \{/, /function twice\(uint256 a\) internal pure returns \(uint256\)/, /using L for uint256;/, /return L\.twice\(a\);/] },
  { id: "x_free_function", feature: "free function + file-level constant", src: `
const CAP = 10n;
export function cap(a: bigint): bigint { return a > CAP ? CAP : a; }
export class C { @pure f(a: bigint): bigint { return cap(a); } }`,
    expect: [/uint256 constant CAP = 10;/, /function cap\(uint256 a\) pure returns \(uint256\)/, /import "\.\/C\.defs\.sol";/] },
  { id: "x_free_view", feature: "free function reading the chain is not pure; @view tag", src: `
/** @view */
export function now(): bigint { return block.timestamp; }
export class C { @view f(): bigint { return now(); } }`, expect: [/function now\(\) view returns \(uint256\)/] },
  { id: "t_function_type", feature: "internal function type", src: `
export class C { @pure private ap(f: Pure<(a: bigint) => bigint>, x: bigint): bigint { return f(x); }
  @pure private inc(a: bigint): bigint { return a + 1n; } @pure g(x: bigint): bigint { return this.ap(this.inc, x); } }`,
    expect: [/function \(uint256\) internal pure returns \(uint256\) f/] },
  { id: "t_external_function_type", feature: "external function type parameter", src: `
export class C { @storage n: bigint = 0n; call(cb: External<View<(a: bigint) => bigint>>): void { this.n = cb(1n); } }`,
    expect: [/function call\(function \(uint256\) external view returns \(uint256\) cb\) public/] },
  { id: "t_value_type", feature: "user-defined value type", src: `
type Price = ValueType<Uint128, "Price">;
export class C { @storage p!: Price; set(x: Uint128): void { this.p = wrap<Price>(x); } @view get(): Uint128 { return unwrap(this.p); } }`,
    expect: [/type Price is uint128;/, /p = Price\.wrap\(x\);/, /return Price\.unwrap\(p\);/] },
  { id: "f_overload", feature: "overloaded functions via @overload", src: `
export class C { @storage n: bigint = 0n;
  @overload("set") setOne(a: bigint): void { this.n = a; }
  @overload("set") setTwo(a: bigint, b: bigint): void { this.setOne(a + b); } }`,
    expect: [/function set\(uint256 a\) public/, /function set\(uint256 a, uint256 b\) public/, /set\(a \+ b\);/] },
  { id: "f_named_returns", feature: "named return values", src: `
export class C { @pure f(a: bigint): [sum: bigint, big: boolean] { const sum = a + 1n; return [sum, sum > 10n]; } }`,
    expect: [/returns \(uint256 sum, bool big\)/, /sum = a \+ 1;/] },
  { id: "x_create2", feature: "new C{salt: s, value: v}(…)", src: `
export class K { @storage n: bigint; /** @payable */ constructor(n: bigint) { this.n = n; } }
export class C { @payable make(s: Bytes32): Address { return address(create(K, { salt: s, value: msg.value }, 1n)); } }`,
    expect: [/new K\{salt: s, value: msg\.value\}\(1\)/, /constructor\(uint256 n_\) payable/] },
  { id: "e_catch_typed", feature: "catch Error(string) / catch Panic(uint256)", src: `
interface IX { go(): bigint; }
export class C { @storage why: string = ""; @storage code: bigint = 0n;
  f(t: Address): void { try { at<IX>(t).go(); } catch { catchError((r) => { this.why = r; }); catchPanic((c) => { this.code = c; }); } } }`,
    expect: [/catch Error\(string memory r\) \{/, /catch Panic\(uint256 c\) \{/] },
  { id: "v_event_anonymous", feature: "anonymous event", src: `
export class C { @storage n: bigint = 0n; @event({ anonymous: true }) Ping(v: bigint): void {} f(): void { this.n += 1n; emit(this.Ping(this.n)); } }`,
    expect: [/event Ping\(uint256 v\) anonymous;/] },
  { id: "s_transient", feature: "transient storage", src: `
export class C { @transient @storage lock!: boolean; f(): void { this.lock = true; } }`,
    expect: [/bool public transient lock;/, /pragma solidity \^0\.8\.28;/] },
);

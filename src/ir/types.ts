export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

/** Valid widths for `uintN` / `intN`: multiples of 8 from 8 to 256. */
export type IntBits =
  | 8 | 16 | 24 | 32 | 40 | 48 | 56 | 64 | 72 | 80 | 88 | 96 | 104 | 112 | 120 | 128
  | 136 | 144 | 152 | 160 | 168 | 176 | 184 | 192 | 200 | 208 | 216 | 224 | 232 | 240 | 248 | 256;

/** Valid widths for `bytesN`: 1 to 32. */
export type BytesN =
  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16
  | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32;

export type IRPrimitiveName =
  | "bool"
  | "string"
  | "address"
  | "void"
  | "bytes"
  | `uint${IntBits}`
  | `int${IntBits}`
  | `bytes${BytesN}`;

export type IRType =
  | { kind: "primitive"; name: IRPrimitiveName }
  | { kind: "mapping"; key: IRType; value: IRType }
  /** `T[]`, or `T[N]` when `length` is set (`FixedArray<T, N>`). */
  | { kind: "array"; element: IRType; length?: number }
  /** A struct declared at file level next to the contract (TS `interface` or object `type`). */
  | { kind: "struct"; name: string }
  /** An enum declared at file level next to the contract (TS `enum`). */
  | { kind: "enum"; name: string }
  /**
   * Several return values: a TS tuple return type `[bigint, boolean]` → `returns (uint256, bool)`.
   * `names` carries a labelled tuple's labels, `[amount: bigint, ok: boolean]`
   * → `returns (uint256 amount, bool ok)`.
   */
  | { kind: "tuple"; elements: IRType[]; names?: Array<string | undefined> }
  /**
   * A function type: TS `(a: bigint) => boolean` → `function (uint256) internal returns (bool)`.
   * `External<F>` makes it `external`; `View<F>` / `Pure<F>` / `Payable<F>` set its mutability.
   */
  | { kind: "function"; params: IRType[]; returns: IRType[]; visibility: "internal" | "external"; mutability?: "view" | "pure" | "payable" }
  | { kind: "custom"; name: string };

export type IRExpression =
  | { kind: "literal"; literalType: "number" | "bigint" | "string" | "boolean"; value: string; raw: string }
  | { kind: "identifier"; name: string }
  | { kind: "this" }
  | { kind: "super" }
  | { kind: "member"; object: IRExpression; property: string }
  | { kind: "index"; object: IRExpression; index: IRExpression }
  /**
   * `options` is Solidity's call-options block: `to.call({ value: v }, data)`
   * → `to.call{value: v}(data)`. `typeArgs` carries TS type arguments the
   * lowering needs, e.g. `abi.decode<[bigint, Address]>(data)`.
   */
  | {
      kind: "call";
      callee: IRExpression;
      args: IRExpression[];
      options?: Array<{ name: string; value: IRExpression }>;
      typeArgs?: IRType[];
      /**
       * A TS `x as Uint8`: `callee` names the Solidity type and `typeArgs[0]`
       * is the target. The emitter writes `uint8(x)` only when `x` is known to
       * have a different type, so a cast TS needed and Solidity does not
       * leaves no trace.
       */
      cast?: boolean;
    }
  /** `new Child(v)`; `type` is set for `new Array<T>(n)` → `new T[](n)`. */
  | { kind: "new"; className: string; args: IRExpression[]; type?: IRType; options?: Array<{ name: string; value: IRExpression }> }
  /** `(a, b)`: a tuple return value, or either side of a tuple assignment `[a, b] = [b, a]`. */
  | { kind: "tuple"; elements: Array<IRExpression | undefined> }
  | { kind: "binary"; op: string; left: IRExpression; right: IRExpression }
  | { kind: "unary"; op: string; operand: IRExpression; prefix: boolean }
  | { kind: "conditional"; test: IRExpression; consequent: IRExpression; alternate: IRExpression }
  | { kind: "nullish"; left: IRExpression; right: IRExpression }
  | { kind: "assign"; op: string; left: IRExpression; right: IRExpression }
  | { kind: "paren"; inner: IRExpression }
  | { kind: "templateString"; tag?: string; quasis: string[]; expressions: IRExpression[] }
  /**
   * An object literal. Lowers to `StructName({a: x, b: y})`; `structName` is
   * filled from an `as StructName` cast or from the type of the slot the
   * literal is assigned to (state var, typed local, return, mapping value…).
   */
  | { kind: "object"; structName?: string; properties: Array<{ name: string; value: IRExpression }> }
  | { kind: "raw"; text: string };

export type IRStatement =
  | { kind: "expression"; expr: IRExpression; loc?: SourceLocation }
  | { kind: "return"; value?: IRExpression; loc?: SourceLocation }
  | { kind: "if"; test: IRExpression; then: IRStatement[]; else?: IRStatement[]; loc?: SourceLocation }
  | { kind: "for"; init?: IRStatement; test?: IRExpression; update?: IRExpression; body: IRStatement[]; uncheckedIncrement?: boolean; loc?: SourceLocation }
  /** `doWhile` is `do { … } while (test);` -- the body runs before the first test. */
  | { kind: "while"; test: IRExpression; body: IRStatement[]; doWhile?: boolean; loc?: SourceLocation }
  | { kind: "block"; body: IRStatement[]; loc?: SourceLocation }
  | { kind: "unchecked"; body: IRStatement[]; loc?: SourceLocation }
  | { kind: "revert"; errorName: string; args: IRExpression[]; loc?: SourceLocation }
  | { kind: "emit"; eventName: string; args: IRExpression[]; loc?: SourceLocation }
  | { kind: "let"; name: string; type?: IRType; init?: IRExpression; isConst: boolean; loc?: SourceLocation }
  /**
   * `const [ok, data] = addr.call("")` → `(bool ok, bytes memory data) = addr.call("");`
   * `names[i]` is undefined for an omitted slot (`const [ok,] = …` → `(bool ok, ) = …`).
   * `types` comes from a tuple annotation; without one the emitter knows the
   * return shape of low-level calls and nothing else.
   */
  | { kind: "destructure"; names: Array<string | undefined>; types?: IRType[]; init: IRExpression; isConst: boolean; loc?: SourceLocation }
  | { kind: "throw"; argument: IRExpression; loc?: SourceLocation }
  | { kind: "break"; loc?: SourceLocation }
  | { kind: "continue"; loc?: SourceLocation }
  /**
   * Solidity's `try` on an external call or `new`:
   * `try call returns (T r) { body } catch Error(string memory reason) { … } catch { … }`.
   * `returns` names what the successful call yields (empty when unused).
   */
  | { kind: "try"; call: IRExpression; returns: IRParam[]; body: IRStatement[]; catches: IRCatchClause[]; loc?: SourceLocation }
  | { kind: "raw"; text: string; loc?: SourceLocation };

/**
 * One `catch` of a `try`. `kind` picks the clause: `Error(string memory reason)`,
 * `Panic(uint256 code)`, the low-level `(bytes memory data)`, or a bare `catch`.
 */
export interface IRCatchClause {
  kind: "error" | "panic" | "bytes" | "any";
  param?: string;
  body: IRStatement[];
}

export interface IRParam {
  name: string;
  type: IRType;
  location?: "memory" | "calldata" | "storage";
}

export interface IRDecorator {
  name: string;
  args: IRExpression[];
}

export interface IRStateVar {
  name: string;
  type: IRType;
  decorators: IRDecorator[];
  initializer?: IRExpression;
  visibility?: "public" | "private" | "internal";
  mutability?: "constant" | "immutable";
  /** `@transient`: EIP-1153 transient storage, cleared at the end of every transaction. */
  transient?: boolean;
  natspec?: string[];
  loc?: SourceLocation;
}

export interface IRSuperCall {
  baseName: string;
  args: IRExpression[];
}

export interface IRErrorDecl {
  name: string;
  params: IRParam[];
  natspec?: string[];
  loc?: SourceLocation;
}

export interface IREventParam {
  name: string;
  type: IRType;
  indexed: boolean;
}

export interface IREventDecl {
  name: string;
  params: IREventParam[];
  /** `@event({ anonymous: true })`: no topic for the signature, so up to four indexed parameters. */
  anonymous?: boolean;
  natspec?: string[];
  loc?: SourceLocation;
}

export interface IRStructDecl {
  name: string;
  fields: IRParam[];
  natspec?: string[];
  loc?: SourceLocation;
}

export interface IREnumDecl {
  name: string;
  members: string[];
  natspec?: string[];
  loc?: SourceLocation;
}

/**
 * A user-defined value type, `type Price is uint128;`, declared in TS as
 * `type Price = ValueType<Uint128, "Price">`.
 */
export interface IRValueTypeDecl {
  name: string;
  underlying: IRType;
  natspec?: string[];
  loc?: SourceLocation;
}

export interface IRFunction {
  /** The Solidity name. Differs from `tsName` when `@overload("name")` renames it. */
  name: string;
  /** The TS method name, when `@overload` gave the function a different Solidity name. */
  tsName?: string;
  isConstructor: boolean;
  /**
   * A function Solidity treats specially: `receive() external payable`,
   * `fallback() external`, or a `modifier` (declared with `@modifier`).
   * Undefined for an ordinary function.
   */
  special?: "receive" | "fallback" | "modifier";
  /** Declared without a body (`abstract f(): T;`): emitted `virtual` with no body. */
  isAbstract?: boolean;
  /** Written with TS `override`: always emitted `override`, even over a base Scriipture cannot see. */
  isOverride?: boolean;
  /**
   * A constructor tagged `/** @payable *\/`. TypeScript allows no decorator
   * on a constructor, so the tag is the spelling; it lets `create(C, { value })`
   * fund the new contract.
   */
  payable?: boolean;
  decorators: IRDecorator[];
  params: IRParam[];
  returnType: IRType;
  body: IRStatement[];
  superCall?: IRSuperCall;
  isAssembly?: boolean;
  assemblyBody?: string;
  natspec?: string[];
  loc?: SourceLocation;
}

export interface IRContract {
  name: string;
  /** `@library class L { static f() … }` → `library L { function f() internal … }`. */
  kind?: "contract" | "library";
  /**
   * `@using(Lib)` / `@using<bigint>(Lib)` on the class → `using Lib for *;` /
   * `using Lib for uint256;`.
   */
  usingFor?: Array<{ library: string; type?: IRType }>;
  /** `abstract class` → `abstract contract`. */
  isAbstract?: boolean;
  bases: string[];
  /** `implements IFoo` → `is IFoo`; each must be an interface declared in this build. */
  interfaces?: string[];
  stateVars: IRStateVar[];
  functions: IRFunction[];
  errors: IRErrorDecl[];
  events: IREventDecl[];
  structs: IRStructDecl[];
  enums: IREnumDecl[];
  /** File-level `ValueType<…>` aliases, declared like structs and enums. */
  valueTypes?: IRValueTypeDecl[];
  sourceFile: string;
  natspec?: string[];
  loc?: SourceLocation;
}

/**
 * What a TS file declares outside any class that Solidity puts at file level:
 * free functions (`export function f(…)`) and constants (`const MAX = 100n`).
 * Emitted, together with any struct, enum or value type a library, an
 * interface or one of these refers to, to a shared `<stem>.defs.sol` that the
 * file's contracts, libraries and interfaces import.
 */
export interface IRFileScope {
  sourceFile: string;
  functions: IRFunction[];
  constants: IRStateVar[];
  structs: IRStructDecl[];
  enums: IREnumDecl[];
  valueTypes: IRValueTypeDecl[];
}

/**
 * A file-level TS `interface` whose members are all methods. It becomes a
 * Solidity `interface` in its own `<Name>.sol`, imported by every contract
 * that names it -- by `at<IFoo>(addr)`, by type, or by `implements`.
 */
export interface IRInterface {
  name: string;
  functions: IRFunction[];
  /** The file's structs, enums and value types, for the ones its signatures use. */
  structs?: IRStructDecl[];
  enums?: IREnumDecl[];
  valueTypes?: IRValueTypeDecl[];
  events: IREventDecl[];
  sourceFile: string;
  natspec?: string[];
  loc?: SourceLocation;
}

export interface IRProgram {
  contracts: IRContract[];
  /** Solidity interfaces declared in this build; each is emitted to its own file. */
  interfaces?: IRInterface[];
  /** Per-file declarations that live outside any contract. */
  files?: IRFileScope[];
}

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
  | { kind: "array"; element: IRType }
  /** A struct declared at file level next to the contract (TS `interface` or object `type`). */
  | { kind: "struct"; name: string }
  /** An enum declared at file level next to the contract (TS `enum`). */
  | { kind: "enum"; name: string }
  | { kind: "custom"; name: string };

export type IRExpression =
  | { kind: "literal"; literalType: "number" | "bigint" | "string" | "boolean"; value: string; raw: string }
  | { kind: "identifier"; name: string }
  | { kind: "this" }
  | { kind: "super" }
  | { kind: "member"; object: IRExpression; property: string }
  | { kind: "index"; object: IRExpression; index: IRExpression }
  | { kind: "call"; callee: IRExpression; args: IRExpression[] }
  | { kind: "new"; className: string; args: IRExpression[] }
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
  | { kind: "while"; test: IRExpression; body: IRStatement[]; loc?: SourceLocation }
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
  | { kind: "raw"; text: string; loc?: SourceLocation };

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

export interface IRFunction {
  name: string;
  isConstructor: boolean;
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
  bases: string[];
  stateVars: IRStateVar[];
  functions: IRFunction[];
  errors: IRErrorDecl[];
  events: IREventDecl[];
  structs: IRStructDecl[];
  enums: IREnumDecl[];
  sourceFile: string;
  natspec?: string[];
  loc?: SourceLocation;
}

export interface IRProgram {
  contracts: IRContract[];
}

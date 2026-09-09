export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

export type IRType =
  | { kind: "primitive"; name: "uint256" | "int256" | "bool" | "string" | "address" | "void" | "bytes" | "bytes32" }
  | { kind: "mapping"; key: IRType; value: IRType }
  | { kind: "array"; element: IRType }
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
  | { kind: "throw"; argument: IRExpression; loc?: SourceLocation }
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
  sourceFile: string;
  natspec?: string[];
  loc?: SourceLocation;
}

export interface IRProgram {
  contracts: IRContract[];
}

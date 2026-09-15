import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import type {
  IRContract,
  IRDecorator,
  IREnumDecl,
  IRErrorDecl,
  IREventDecl,
  IREventParam,
  IRExpression,
  IRFunction,
  IRParam,
  IRPrimitiveName,
  IRProgram,
  IRStateVar,
  IRStatement,
  IRStructDecl,
  IRSuperCall,
  IRType,
  SourceLocation,
} from "../ir/types";
import { walkStatements, walkExpressionsInStatement } from "../optimizer/walk";

export interface ParseDiagnostic {
  message: string;
  loc: SourceLocation;
}

export interface ParseResult {
  program: IRProgram;
  diagnostics: ParseDiagnostic[];
}

export function parseContractFiles(filePaths: string[]): ParseResult {
  const program: IRProgram = { contracts: [] };
  const diagnostics: ParseDiagnostic[] = [];

  for (const filePath of filePaths) {
    const absPath = path.resolve(filePath);
    const source = fs.readFileSync(absPath, "utf8");
    const sourceFile = ts.createSourceFile(absPath, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const ctx: ParseContext = { sourceFile, filePath: absPath, diagnostics, structs: new Map(), enums: new Map() };

    // Structs and enums are declared at file level, next to the contract class,
    // and may be referenced before they are declared -- so collect them first.
    sourceFile.forEachChild((node) => {
      if (ts.isEnumDeclaration(node)) {
        const en = parseEnumDecl(node, ctx);
        ctx.enums.set(en.name, en);
      } else if (ts.isInterfaceDeclaration(node)) {
        const st = parseStructDecl(node.name.text, node.members, node, ctx);
        ctx.structs.set(st.name, st);
      } else if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
        const st = parseStructDecl(node.name.text, node.type.members, node, ctx);
        ctx.structs.set(st.name, st);
      }
    });

    sourceFile.forEachChild((node) => {
      if (ts.isClassDeclaration(node) && node.name) {
        const contract = parseClass(node, ctx);
        resolveStructLiterals(contract, ctx);
        program.contracts.push(contract);
      }
    });
  }

  return { program, diagnostics };
}

interface ParseContext {
  sourceFile: ts.SourceFile;
  filePath: string;
  diagnostics: ParseDiagnostic[];
  /** File-level struct declarations (TS `interface` / object `type`), by name. */
  structs: Map<string, IRStructDecl>;
  /** File-level `enum` declarations, by name. */
  enums: Map<string, IREnumDecl>;
}

function loc(node: ts.Node, ctx: ParseContext): SourceLocation {
  const pos = ctx.sourceFile.getLineAndCharacterOfPosition(node.getStart(ctx.sourceFile));
  return { file: ctx.filePath, line: pos.line + 1, column: pos.character + 1 };
}

function parseClass(cls: ts.ClassDeclaration, ctx: ParseContext): IRContract {
  const name = cls.name!.text;
  const bases: string[] = [];
  if (cls.heritageClauses) {
    for (const clause of cls.heritageClauses) {
      if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
        for (const t of clause.types) {
          bases.push(t.expression.getText(ctx.sourceFile));
        }
      }
    }
  }

  const stateVars: IRStateVar[] = [];
  const functions: IRFunction[] = [];
  const events: IREventDecl[] = [];
  const errors: IRErrorDecl[] = [];

  for (const member of cls.members) {
    if (ts.isPropertyDeclaration(member)) {
      stateVars.push(parseStateVar(member, ctx));
    } else if (ts.isMethodDeclaration(member)) {
      // @event members declare a Solidity event rather than a function; the
      // method body exists only to satisfy TypeScript and is discarded.
      if (hasDecorator(member, "event", ctx)) {
        events.push(parseEvent(member, ctx));
      } else if (hasDecorator(member, "error", ctx)) {
        errors.push(parseErrorDecl(member, ctx));
      } else {
        functions.push(parseMethod(member, ctx));
      }
    } else if (ts.isConstructorDeclaration(member)) {
      functions.push(parseConstructor(member, ctx));
    }
  }

  return {
    name,
    bases,
    stateVars,
    functions,
    errors,
    events,
    // Every contract in the file gets the file's declarations; each contract
    // is emitted to its own .sol, so nothing collides.
    structs: Array.from(ctx.structs.values()),
    enums: Array.from(ctx.enums.values()),
    sourceFile: ctx.filePath,
    natspec: extractNatspec(cls, ctx),
    loc: loc(cls, ctx),
  };
}

function extractNatspec(node: ts.Node, ctx: ParseContext): string[] | undefined {
  const text = ctx.sourceFile.text;
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart());
  if (!ranges || ranges.length === 0) return undefined;
  const lines: string[] = [];
  for (const r of ranges) {
    const raw = text.slice(r.pos, r.end);
    if (raw.startsWith("//")) {
      lines.push(raw.replace(/^\/\/+\s?/, "").trimEnd());
    } else if (raw.startsWith("/*")) {
      const inner = raw.replace(/^\/\*+/, "").replace(/\*+\/$/, "");
      for (const ln of inner.split("\n")) {
        lines.push(ln.replace(/^\s*\*?\s?/, "").trimEnd());
      }
    }
  }
  return lines.length > 0 ? lines : undefined;
}

function hasDecorator(node: ts.HasDecorators, name: string, ctx: ParseContext): boolean {
  return parseDecorators(node, ctx).some((d) => d.name === name);
}

/**
 * `Indexed<T>` marks an event parameter as indexed. It is a marker only -- the
 * underlying type is what gets emitted.
 */
function unwrapIndexed(typeNode: ts.TypeNode, ctx: ParseContext): { type: IRType; indexed: boolean } {
  if (ts.isTypeReferenceNode(typeNode)) {
    const name = typeNode.typeName.getText(ctx.sourceFile);
    const args = typeNode.typeArguments ?? [];
    if (name === "Indexed" && args.length === 1) {
      return { type: parseType(args[0]!, ctx), indexed: true };
    }
  }
  return { type: parseType(typeNode, ctx), indexed: false };
}

function parseErrorDecl(method: ts.MethodDeclaration, ctx: ParseContext): IRErrorDecl {
  return {
    name: method.name.getText(ctx.sourceFile),
    params: method.parameters.map((p) => parseParam(p, ctx)),
    natspec: extractNatspec(method, ctx),
    loc: loc(method, ctx),
  };
}

function parseEvent(method: ts.MethodDeclaration, ctx: ParseContext): IREventDecl {
  const name = method.name.getText(ctx.sourceFile);
  const params: IREventParam[] = method.parameters.map((p) => {
    const pname = p.name.getText(ctx.sourceFile);
    const { type, indexed } = p.type
      ? unwrapIndexed(p.type, ctx)
      : { type: { kind: "custom", name: "unknown" } as IRType, indexed: false };
    return { name: pname, type, indexed };
  });
  return { name, params, natspec: extractNatspec(method, ctx), loc: loc(method, ctx) };
}

function parseStateVar(prop: ts.PropertyDeclaration, ctx: ParseContext): IRStateVar {
  const name = prop.name.getText(ctx.sourceFile);
  const type = prop.type ? parseType(prop.type, ctx) : { kind: "custom", name: "unknown" } as IRType;
  const decorators = parseDecorators(prop, ctx);
  const initializer = prop.initializer ? parseExpression(prop.initializer, ctx) : undefined;
  return { name, type, decorators, initializer, natspec: extractNatspec(prop, ctx), loc: loc(prop, ctx) };
}

function parseMethod(method: ts.MethodDeclaration, ctx: ParseContext): IRFunction {
  const name = method.name.getText(ctx.sourceFile);
  const params = method.parameters.map((p) => parseParam(p, ctx));
  const returnType = method.type ? parseType(method.type, ctx) : { kind: "primitive", name: "void" } as IRType;
  const decorators = parseDecorators(method, ctx);
  const body = method.body ? parseBlockBody(method.body, ctx) : [];

  const isAssembly = decorators.some((d) => d.name === "assembly");
  let assemblyBody: string | undefined;
  if (isAssembly && method.body) {
    assemblyBody = extractAssemblyBody(method.body, ctx);
  }

  return {
    name,
    isConstructor: false,
    decorators,
    params,
    returnType,
    body,
    isAssembly,
    assemblyBody,
    natspec: extractNatspec(method, ctx),
    loc: loc(method, ctx),
  };
}

function extractAssemblyBody(block: ts.Block, ctx: ParseContext): string {
  for (const stmt of block.statements) {
    let candidate: ts.Expression | undefined;
    if (ts.isReturnStatement(stmt) && stmt.expression) candidate = stmt.expression;
    if (ts.isExpressionStatement(stmt)) candidate = stmt.expression;
    if (!candidate) continue;
    let expr = candidate;
    while (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr)) {
      expr = expr.expression;
    }
    if (ts.isTaggedTemplateExpression(expr)) {
      const tag = expr.tag.getText(ctx.sourceFile);
      if (tag === "yul" || tag === "solidity") {
        if (ts.isNoSubstitutionTemplateLiteral(expr.template)) return expr.template.text;
        if (ts.isTemplateExpression(expr.template)) {
          let out = expr.template.head.text;
          for (const span of expr.template.templateSpans) {
            out += span.expression.getText(ctx.sourceFile) + span.literal.text;
          }
          return out;
        }
      }
    }
  }
  return "";
}

function parseConstructor(ctor: ts.ConstructorDeclaration, ctx: ParseContext): IRFunction {
  const params = ctor.parameters.map((p) => parseParam(p, ctx));
  const body = ctor.body ? parseBlockBody(ctor.body, ctx) : [];

  let superCall: IRSuperCall | undefined;
  const filteredBody: IRStatement[] = [];
  for (const stmt of body) {
    if (stmt.kind === "expression" && stmt.expr.kind === "call" && stmt.expr.callee.kind === "super") {
      superCall = extractSuperCall(stmt.expr.args, ctx, ctor);
    } else {
      filteredBody.push(stmt);
    }
  }

  return {
    name: "constructor",
    isConstructor: true,
    decorators: [],
    params,
    returnType: { kind: "primitive", name: "void" },
    body: filteredBody,
    superCall,
    loc: loc(ctor, ctx),
  };
}

function extractSuperCall(args: IRExpression[], ctx: ParseContext, ctor: ts.ConstructorDeclaration): IRSuperCall {
  const parent = ctor.parent as ts.ClassDeclaration;
  let baseName = "Base";
  if (parent.heritageClauses) {
    for (const clause of parent.heritageClauses) {
      if (clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types[0]) {
        baseName = clause.types[0].expression.getText(ctx.sourceFile);
      }
    }
  }
  return { baseName, args };
}

function parseParam(param: ts.ParameterDeclaration, ctx: ParseContext): IRParam {
  const name = param.name.getText(ctx.sourceFile);
  const type = param.type ? parseType(param.type, ctx) : { kind: "custom", name: "unknown" } as IRType;
  return { name, type };
}

function parseDecorators(node: ts.HasDecorators, ctx: ParseContext): IRDecorator[] {
  if (!ts.canHaveDecorators(node)) return [];
  const decs = ts.getDecorators(node) ?? [];
  return decs.map((d) => {
    if (ts.isCallExpression(d.expression)) {
      return {
        name: d.expression.expression.getText(ctx.sourceFile),
        args: d.expression.arguments.map((a) => parseExpression(a, ctx)),
      };
    }
    return { name: d.expression.getText(ctx.sourceFile), args: [] };
  });
}

function parseEnumDecl(node: ts.EnumDeclaration, ctx: ParseContext): IREnumDecl {
  const members: string[] = [];
  for (const m of node.members) {
    members.push(m.name.getText(ctx.sourceFile));
    if (m.initializer) {
      ctx.diagnostics.push({
        message: `enum ${node.name.text}.${m.name.getText(ctx.sourceFile)}: Solidity enums number their members 0, 1, 2… in declaration order; remove the initializer`,
        loc: loc(m, ctx),
      });
    }
  }
  return { name: node.name.text, members, natspec: extractNatspec(node, ctx), loc: loc(node, ctx) };
}

function parseStructDecl(
  name: string,
  members: ts.NodeArray<ts.TypeElement>,
  node: ts.Node,
  ctx: ParseContext,
): IRStructDecl {
  const fields: IRParam[] = [];
  for (const m of members) {
    if (!ts.isPropertySignature(m) || !m.type) {
      ctx.diagnostics.push({
        message: `struct ${name}: only typed property fields are supported (methods, index signatures and call signatures have no Solidity equivalent)`,
        loc: loc(m, ctx),
      });
      continue;
    }
    if (m.questionToken) {
      ctx.diagnostics.push({ message: `struct ${name}.${m.name.getText(ctx.sourceFile)}: Solidity struct fields cannot be optional`, loc: loc(m, ctx) });
    }
    fields.push({ name: m.name.getText(ctx.sourceFile), type: parseType(m.type, ctx) });
  }
  return { name, fields, natspec: extractNatspec(node, ctx), loc: loc(node, ctx) };
}

/** `Uint8` … `Uint256`, `Int8` … `Int256`, `Bytes1` … `Bytes32` → the matching Solidity primitive. */
function sizedPrimitive(name: string, node: ts.Node, ctx: ParseContext): IRType | undefined {
  const int = /^(Uint|Int)(\d+)$/.exec(name);
  if (int) {
    const bits = Number(int[2]);
    const prefix = int[1] === "Uint" ? "uint" : "int";
    if (bits >= 8 && bits <= 256 && bits % 8 === 0) return { kind: "primitive", name: `${prefix}${bits}` as IRPrimitiveName };
    ctx.diagnostics.push({ message: `${name}: integer width must be a multiple of 8 between 8 and 256`, loc: loc(node, ctx) });
    return { kind: "primitive", name: `${prefix}256` };
  }
  const bytes = /^Bytes(\d+)$/.exec(name);
  if (bytes) {
    const n = Number(bytes[1]);
    if (n >= 1 && n <= 32) return { kind: "primitive", name: `bytes${n}` as IRPrimitiveName };
    ctx.diagnostics.push({ message: `${name}: fixed byte width must be between 1 and 32`, loc: loc(node, ctx) });
    return { kind: "primitive", name: "bytes32" };
  }
  return undefined;
}

function parseType(typeNode: ts.TypeNode, ctx: ParseContext): IRType {
  if (ts.isTypeReferenceNode(typeNode)) {
    const name = typeNode.typeName.getText(ctx.sourceFile);
    const args = typeNode.typeArguments ?? [];
    if (name === "Map" && args.length === 2) {
      return { kind: "mapping", key: parseType(args[0]!, ctx), value: parseType(args[1]!, ctx) };
    }
    if (name === "Array" && args.length === 1) {
      return { kind: "array", element: parseType(args[0]!, ctx) };
    }
    if (name === "Address") return { kind: "primitive", name: "address" };
    if (name === "Bytes") return { kind: "primitive", name: "bytes" };
    const sized = sizedPrimitive(name, typeNode, ctx);
    if (sized) return sized;
    if (ctx.structs.has(name)) return { kind: "struct", name };
    if (ctx.enums.has(name)) return { kind: "enum", name };
    return { kind: "custom", name };
  }
  if (ts.isArrayTypeNode(typeNode)) {
    return { kind: "array", element: parseType(typeNode.elementType, ctx) };
  }
  switch (typeNode.kind) {
    case ts.SyntaxKind.BigIntKeyword:
      return { kind: "primitive", name: "uint256" };
    case ts.SyntaxKind.NumberKeyword:
      return { kind: "primitive", name: "uint256" };
    case ts.SyntaxKind.BooleanKeyword:
      return { kind: "primitive", name: "bool" };
    case ts.SyntaxKind.StringKeyword:
      return { kind: "primitive", name: "string" };
    case ts.SyntaxKind.VoidKeyword:
      return { kind: "primitive", name: "void" };
  }
  return { kind: "custom", name: typeNode.getText(ctx.sourceFile) };
}

function parseBlockBody(body: ts.Block, ctx: ParseContext): IRStatement[] {
  return body.statements.map((s) => parseStatement(s, ctx));
}

/**
 * `emit(Transfer(a, b))` is a statement in Solidity, not a call, so it is
 * lowered here rather than in emitCall -- otherwise it emits `emit(...)`, which
 * solc rejects with "Expected event name or path".
 */
function tryParseEmit(expr: ts.Expression, ctx: ParseContext, l?: SourceLocation): IRStatement | undefined {
  if (!ts.isCallExpression(expr)) return undefined;
  if (expr.expression.getText(ctx.sourceFile) !== "emit") return undefined;
  const [arg] = expr.arguments;
  if (!arg || expr.arguments.length !== 1 || !ts.isCallExpression(arg)) return undefined;
  return {
    kind: "emit",
    eventName: arg.expression.getText(ctx.sourceFile),
    args: arg.arguments.map((a) => parseExpression(a, ctx)),
    loc: l,
  };
}

/**
 * `revert(InsufficientBalance(a, b))` is Solidity's `revert Name(a, b);` -- a
 * statement, not a call. Only a call argument is treated this way, so
 * `revert("msg")` keeps its existing string-revert lowering in emitCall.
 */
function tryParseRevert(expr: ts.Expression, ctx: ParseContext, l?: SourceLocation): IRStatement | undefined {
  if (!ts.isCallExpression(expr)) return undefined;
  if (expr.expression.getText(ctx.sourceFile) !== "revert") return undefined;
  const [arg] = expr.arguments;
  if (!arg || expr.arguments.length !== 1 || !ts.isCallExpression(arg)) return undefined;
  return {
    kind: "revert",
    errorName: arg.expression.getText(ctx.sourceFile),
    args: arg.arguments.map((a) => parseExpression(a, ctx)),
    loc: l,
  };
}

function parseStatement(stmt: ts.Statement, ctx: ParseContext): IRStatement {
  const l = loc(stmt, ctx);
  if (ts.isExpressionStatement(stmt)) {
    const emitted = tryParseEmit(stmt.expression, ctx, l);
    if (emitted) return emitted;
    const reverted = tryParseRevert(stmt.expression, ctx, l);
    if (reverted) return reverted;
    return { kind: "expression", expr: parseExpression(stmt.expression, ctx), loc: l };
  }
  if (ts.isReturnStatement(stmt)) {
    return { kind: "return", value: stmt.expression ? parseExpression(stmt.expression, ctx) : undefined, loc: l };
  }
  if (ts.isIfStatement(stmt)) {
    return {
      kind: "if",
      test: parseExpression(stmt.expression, ctx),
      then: branchToStatements(stmt.thenStatement, ctx),
      else: stmt.elseStatement ? branchToStatements(stmt.elseStatement, ctx) : undefined,
      loc: l,
    };
  }
  if (ts.isForStatement(stmt)) {
    let init: IRStatement | undefined;
    if (stmt.initializer) {
      if (ts.isVariableDeclarationList(stmt.initializer)) {
        const first = stmt.initializer.declarations[0];
        if (first) {
          init = {
            kind: "let",
            name: first.name.getText(ctx.sourceFile),
            type: first.type ? parseType(first.type, ctx) : undefined,
            init: first.initializer ? parseExpression(first.initializer, ctx) : undefined,
            isConst: (stmt.initializer.flags & ts.NodeFlags.Const) !== 0,
            loc: l,
          };
        }
      } else {
        init = { kind: "expression", expr: parseExpression(stmt.initializer, ctx), loc: l };
      }
    }
    return {
      kind: "for",
      init,
      test: stmt.condition ? parseExpression(stmt.condition, ctx) : undefined,
      update: stmt.incrementor ? parseExpression(stmt.incrementor, ctx) : undefined,
      body: branchToStatements(stmt.statement, ctx),
      loc: l,
    };
  }
  if (ts.isWhileStatement(stmt)) {
    return {
      kind: "while",
      test: parseExpression(stmt.expression, ctx),
      body: branchToStatements(stmt.statement, ctx),
      loc: l,
    };
  }
  if (ts.isBlock(stmt)) {
    return { kind: "block", body: parseBlockBody(stmt, ctx), loc: l };
  }
  if (ts.isVariableStatement(stmt)) {
    const first = stmt.declarationList.declarations[0];
    if (first) {
      return {
        kind: "let",
        name: first.name.getText(ctx.sourceFile),
        type: first.type ? parseType(first.type, ctx) : undefined,
        init: first.initializer ? parseExpression(first.initializer, ctx) : undefined,
        isConst: (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0,
        loc: l,
      };
    }
  }
  if (ts.isThrowStatement(stmt)) {
    return { kind: "throw", argument: parseExpression(stmt.expression, ctx), loc: l };
  }
  return { kind: "raw", text: stmt.getText(ctx.sourceFile), loc: l };
}

function branchToStatements(stmt: ts.Statement, ctx: ParseContext): IRStatement[] {
  if (ts.isBlock(stmt)) return parseBlockBody(stmt, ctx);
  return [parseStatement(stmt, ctx)];
}

function parseExpression(expr: ts.Expression, ctx: ParseContext): IRExpression {
  if (ts.isParenthesizedExpression(expr)) {
    return { kind: "paren", inner: parseExpression(expr.expression, ctx) };
  }
  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) {
    // `{ … } as Proposal` names the struct an object literal builds.
    if (ts.isObjectLiteralExpression(expr.expression)) {
      const obj = parseObjectLiteral(expr.expression, ctx);
      const t = parseType(expr.type, ctx);
      if (t.kind === "struct") obj.structName = t.name;
      return obj;
    }
    return parseExpression(expr.expression, ctx);
  }
  if (ts.isTypeAssertionExpression(expr) || ts.isNonNullExpression(expr)) {
    return parseExpression(expr.expression, ctx);
  }
  if (ts.isObjectLiteralExpression(expr)) {
    return parseObjectLiteral(expr, ctx);
  }
  if (ts.isNumericLiteral(expr)) {
    return { kind: "literal", literalType: "number", value: expr.text, raw: expr.getText(ctx.sourceFile) };
  }
  if (ts.isBigIntLiteral(expr)) {
    return { kind: "literal", literalType: "bigint", value: expr.text.replace(/n$/, ""), raw: expr.getText(ctx.sourceFile) };
  }
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return { kind: "literal", literalType: "string", value: expr.text, raw: expr.getText(ctx.sourceFile) };
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    return { kind: "literal", literalType: "boolean", value: "true", raw: "true" };
  }
  if (expr.kind === ts.SyntaxKind.FalseKeyword) {
    return { kind: "literal", literalType: "boolean", value: "false", raw: "false" };
  }
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return { kind: "this" };
  if (expr.kind === ts.SyntaxKind.SuperKeyword) return { kind: "super" };
  if (ts.isIdentifier(expr)) return { kind: "identifier", name: expr.text };
  if (ts.isPropertyAccessExpression(expr)) {
    return {
      kind: "member",
      object: parseExpression(expr.expression, ctx),
      property: expr.name.text,
    };
  }
  if (ts.isElementAccessExpression(expr)) {
    return {
      kind: "index",
      object: parseExpression(expr.expression, ctx),
      index: parseExpression(expr.argumentExpression, ctx),
    };
  }
  if (ts.isCallExpression(expr)) {
    if (ts.isIdentifier(expr.expression) && expr.arguments.length === 1) {
      const calleeName = expr.expression.text;
      if (calleeName === "Number" || calleeName === "BigInt") {
        return parseExpression(expr.arguments[0]!, ctx);
      }
    }
    return {
      kind: "call",
      callee: parseExpression(expr.expression, ctx),
      args: expr.arguments.map((a) => parseExpression(a, ctx)),
    };
  }
  if (ts.isNewExpression(expr)) {
    return {
      kind: "new",
      className: expr.expression.getText(ctx.sourceFile),
      args: (expr.arguments ?? []).map((a) => parseExpression(a, ctx)),
    };
  }
  if (ts.isBinaryExpression(expr)) {
    const opText = expr.operatorToken.getText(ctx.sourceFile);
    const left = parseExpression(expr.left, ctx);
    const right = parseExpression(expr.right, ctx);
    if (opText === "??") return { kind: "nullish", left, right };
    if (opText.endsWith("=") && !["==", "!=", "===", "!==", "<=", ">="].includes(opText)) {
      return { kind: "assign", op: opText, left, right };
    }
    return { kind: "binary", op: opText, left, right };
  }
  if (ts.isPrefixUnaryExpression(expr)) {
    return { kind: "unary", op: ts.tokenToString(expr.operator) ?? "", operand: parseExpression(expr.operand, ctx), prefix: true };
  }
  if (ts.isPostfixUnaryExpression(expr)) {
    return { kind: "unary", op: ts.tokenToString(expr.operator) ?? "", operand: parseExpression(expr.operand, ctx), prefix: false };
  }
  if (ts.isConditionalExpression(expr)) {
    return {
      kind: "conditional",
      test: parseExpression(expr.condition, ctx),
      consequent: parseExpression(expr.whenTrue, ctx),
      alternate: parseExpression(expr.whenFalse, ctx),
    };
  }
  if (ts.isTaggedTemplateExpression(expr)) {
    const tag = expr.tag.getText(ctx.sourceFile);
    return parseTemplate(expr.template, ctx, tag);
  }
  if (ts.isTemplateExpression(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return parseTemplate(expr, ctx);
  }
  return { kind: "raw", text: expr.getText(ctx.sourceFile) };
}

function parseObjectLiteral(
  expr: ts.ObjectLiteralExpression,
  ctx: ParseContext,
): Extract<IRExpression, { kind: "object" }> {
  const properties: Array<{ name: string; value: IRExpression }> = [];
  for (const p of expr.properties) {
    if (ts.isPropertyAssignment(p)) {
      properties.push({ name: p.name.getText(ctx.sourceFile), value: parseExpression(p.initializer, ctx) });
    } else if (ts.isShorthandPropertyAssignment(p)) {
      properties.push({ name: p.name.text, value: { kind: "identifier", name: p.name.text } });
    } else {
      ctx.diagnostics.push({
        message: "object literal: only `name: value` and shorthand `name` fields can become struct fields (no spreads, methods or accessors)",
        loc: loc(p, ctx),
      });
    }
  }
  return { kind: "object", properties };
}

/**
 * Solidity needs the struct name to build a struct (`Proposal({…})`), while a
 * TS object literal carries none. Fill it in from the type of whatever the
 * literal flows into: a state var initializer, a typed local, a return value,
 * a mapping/array element, or a parameter of one of the contract's own methods.
 * Nested literals take their type from the enclosing struct's field.
 */
function resolveStructLiterals(contract: IRContract, ctx: ParseContext): void {
  const stateTypes = new Map(contract.stateVars.map((v) => [v.name, v.type]));
  const fnParams = new Map(contract.functions.map((f) => [f.name, f.params.map((p) => p.type)]));

  const expect = (e: IRExpression | undefined, t: IRType | undefined): void => {
    if (!e || !t) return;
    const inner = e.kind === "paren" ? e.inner : e;
    if (inner.kind !== "object" || t.kind !== "struct") return;
    inner.structName ??= t.name;
    const decl = ctx.structs.get(inner.structName);
    if (!decl) return;
    for (const p of inner.properties) expect(p.value, decl.fields.find((f) => f.name === p.name)?.type);
  };
  const stateVarOf = (e: IRExpression): IRType | undefined =>
    e.kind === "member" && e.object.kind === "this" ? stateTypes.get(e.property) : undefined;
  const elementOf = (t: IRType | undefined): IRType | undefined =>
    t?.kind === "mapping" ? t.value : t?.kind === "array" ? t.element : undefined;

  for (const v of contract.stateVars) expect(v.initializer, v.type);

  for (const fn of contract.functions) {
    walkStatements(fn.body, (s) => {
      if (s.kind === "let") expect(s.init, s.type);
      if (s.kind === "return") expect(s.value, fn.returnType);
      walkExpressionsInStatement(s, (e) => {
        if (e.kind === "assign") {
          if (e.left.kind === "member") expect(e.right, stateVarOf(e.left));
          if (e.left.kind === "index") expect(e.right, elementOf(stateVarOf(e.left.object)));
        }
        if (e.kind === "call" && e.callee.kind === "member") {
          const target = stateVarOf(e.callee.object);
          if (e.callee.property === "set" && e.args.length === 2) expect(e.args[1], elementOf(target));
          if (e.callee.property === "push" && e.args.length === 1) expect(e.args[0], elementOf(target));
          if (e.callee.object.kind === "this") {
            const params = fnParams.get(e.callee.property);
            if (params) e.args.forEach((a, i) => expect(a, params[i]));
          }
        }
      });
    });
  }

  // Anything still unnamed cannot be emitted as valid Solidity.
  const report = (e: IRExpression, at: SourceLocation | undefined): void => {
    if (e.kind === "object" && !e.structName) {
      ctx.diagnostics.push({
        message: `object literal has no struct type; write \`{ … } as <Struct>\` or assign it to a typed slot`,
        loc: at ?? { file: ctx.filePath, line: 1, column: 1 },
      });
    }
  };
  for (const v of contract.stateVars) if (v.initializer) walkExprTree(v.initializer, (e) => report(e, v.loc));
  for (const fn of contract.functions) {
    walkStatements(fn.body, (s) => walkExpressionsInStatement(s, (e) => report(e, s.loc ?? fn.loc)));
  }
}

function walkExprTree(expr: IRExpression, visit: (e: IRExpression) => void): void {
  walkExpressionsInStatement({ kind: "expression", expr }, visit);
}

function parseTemplate(
  tmpl: ts.TemplateExpression | ts.NoSubstitutionTemplateLiteral | ts.TemplateLiteral,
  ctx: ParseContext,
  tag?: string,
): IRExpression {
  if (ts.isNoSubstitutionTemplateLiteral(tmpl)) {
    return { kind: "templateString", tag, quasis: [tmpl.text], expressions: [] };
  }
  const quasis: string[] = [tmpl.head.text];
  const expressions: IRExpression[] = [];
  for (const span of tmpl.templateSpans) {
    expressions.push(parseExpression(span.expression, ctx));
    quasis.push(span.literal.text);
  }
  return { kind: "templateString", tag, quasis, expressions };
}

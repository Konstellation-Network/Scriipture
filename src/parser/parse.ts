import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import type {
  IRContract,
  IRDecorator,
  IREventDecl,
  IREventParam,
  IRExpression,
  IRFunction,
  IRParam,
  IRProgram,
  IRStateVar,
  IRStatement,
  IRSuperCall,
  IRType,
  SourceLocation,
} from "../ir/types";

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
    const ctx: ParseContext = { sourceFile, filePath: absPath, diagnostics };

    sourceFile.forEachChild((node) => {
      if (ts.isClassDeclaration(node) && node.name) {
        program.contracts.push(parseClass(node, ctx));
      }
    });
  }

  return { program, diagnostics };
}

interface ParseContext {
  sourceFile: ts.SourceFile;
  filePath: string;
  diagnostics: ParseDiagnostic[];
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

  for (const member of cls.members) {
    if (ts.isPropertyDeclaration(member)) {
      stateVars.push(parseStateVar(member, ctx));
    } else if (ts.isMethodDeclaration(member)) {
      // @event members declare a Solidity event rather than a function; the
      // method body exists only to satisfy TypeScript and is discarded.
      if (hasDecorator(member, "event", ctx)) {
        events.push(parseEvent(member, ctx));
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
    errors: [],
    events,
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

function parseStatement(stmt: ts.Statement, ctx: ParseContext): IRStatement {
  const l = loc(stmt, ctx);
  if (ts.isExpressionStatement(stmt)) {
    const emitted = tryParseEmit(stmt.expression, ctx, l);
    if (emitted) return emitted;
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
  if (ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr) || ts.isNonNullExpression(expr) || ts.isSatisfiesExpression(expr)) {
    return parseExpression(expr.expression, ctx);
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

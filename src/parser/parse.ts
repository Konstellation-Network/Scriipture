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
  IRInterface,
  IRParam,
  IRPrimitiveName,
  IRProgram,
  IRStateVar,
  IRStatement,
  IRStructDecl,
  IRCatchClause,
  IRSuperCall,
  IRType,
  SourceLocation,
} from "../ir/types";
import { walkStatements, walkExpressionsInStatement } from "../optimizer/walk";
import { SUPPORTED_ASSIGN_OPS, SUPPORTED_BINARY_OPS } from "../mapper/expressions";

export interface ParseDiagnostic {
  message: string;
  loc: SourceLocation;
}

export interface ParseResult {
  program: IRProgram;
  diagnostics: ParseDiagnostic[];
}

export function parseContractFiles(filePaths: string[]): ParseResult {
  const program: IRProgram = { contracts: [], interfaces: [] };
  const diagnostics: ParseDiagnostic[] = [];

  for (const filePath of filePaths) {
    const absPath = path.resolve(filePath);
    const source = fs.readFileSync(absPath, "utf8");
    const sourceFile = ts.createSourceFile(absPath, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const ctx: ParseContext = { sourceFile, filePath: absPath, diagnostics, structs: new Map(), enums: new Map(), interfaceNames: new Set() };

    // Structs and enums are declared at file level, next to the contract class,
    // and may be referenced before they are declared -- by the class, and by
    // each other. So: enums and struct *names* first, struct fields second,
    // otherwise `interface A { b: B }` ahead of `interface B` reads `b` as an
    // opaque `custom` type instead of a struct.
    const structNodes: Array<{ name: string; members: ts.NodeArray<ts.TypeElement>; node: ts.Node }> = [];
    const interfaceNodes: ts.InterfaceDeclaration[] = [];
    sourceFile.forEachChild((node) => {
      if (ts.isEnumDeclaration(node)) {
        const en = parseEnumDecl(node, ctx);
        ctx.enums.set(en.name, en);
      } else if (ts.isInterfaceDeclaration(node) && isInterfaceShaped(node.members)) {
        // Only methods: a Solidity interface, not a struct.
        interfaceNodes.push(node);
        ctx.interfaceNames.add(node.name.text);
      } else if (ts.isInterfaceDeclaration(node)) {
        structNodes.push({ name: node.name.text, members: node.members, node });
      } else if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
        structNodes.push({ name: node.name.text, members: node.type.members, node });
      }
    });
    for (const s of structNodes) {
      if (isStructShaped(s.members)) ctx.structs.set(s.name, { name: s.name, fields: [], natspec: extractNatspec(s.node, ctx), loc: loc(s.node, ctx) });
    }
    for (const s of structNodes) registerStruct(s.name, s.members, s.node, ctx);
    for (const node of interfaceNodes) {
      const iface = parseInterfaceDecl(node, ctx);
      const dup = program.interfaces!.find((i) => i.name === iface.name);
      if (dup) {
        ctx.diagnostics.push({ message: `interface ${iface.name} is declared twice in this build (also at ${dup.sourceFile}:${dup.loc?.line}); each becomes ${iface.name}.sol, so one would overwrite the other`, loc: iface.loc! });
      } else {
        program.interfaces!.push(iface);
      }
    }

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
  /** File-level method-only `interface` declarations, which become Solidity interfaces. */
  interfaceNames: Set<string>;
  /** Declared return type of the method being parsed; `return [a, b]` is a tuple only against a tuple type. */
  returnType?: IRType;
}

function loc(node: ts.Node, ctx: ParseContext): SourceLocation {
  const pos = ctx.sourceFile.getLineAndCharacterOfPosition(node.getStart(ctx.sourceFile));
  return { file: ctx.filePath, line: pos.line + 1, column: pos.character + 1 };
}

function parseClass(cls: ts.ClassDeclaration, ctx: ParseContext): IRContract {
  const name = cls.name!.text;
  const bases: string[] = [];
  const interfaces: string[] = [];
  if (cls.heritageClauses) {
    for (const clause of cls.heritageClauses) {
      for (const t of clause.types) {
        const target = t.expression.getText(ctx.sourceFile);
        if (clause.token === ts.SyntaxKind.ExtendsKeyword) bases.push(target);
        else interfaces.push(target);
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
    } else if (ts.isGetAccessor(member) || ts.isSetAccessor(member)) {
      // Dropping these silently removed code, and the `constant` pass then saw
      // a state variable nothing assigned and froze it.
      ctx.diagnostics.push({
        message: `${ts.isGetAccessor(member) ? "getter" : "setter"} "${member.name.getText(ctx.sourceFile)}" has no Solidity equivalent; write it as a method (\`${member.name.getText(ctx.sourceFile)}(): T\` / \`set${cap(member.name.getText(ctx.sourceFile))}(v: T): void\`)`,
        loc: loc(member, ctx),
      });
    } else if (!isIgnorableMember(member)) {
      ctx.diagnostics.push({
        message: `class member of kind ${ts.SyntaxKind[member.kind]} cannot be lowered to Solidity`,
        loc: loc(member, ctx),
      });
    }
  }

  return {
    name,
    isAbstract: hasModifier(cls, ts.SyntaxKind.AbstractKeyword) || undefined,
    bases,
    interfaces: interfaces.length > 0 ? interfaces : undefined,
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
  const clean = sanitizeNatspec(lines);
  return clean.length > 0 ? clean : undefined;
}

/** The tags solc accepts in NatSpec; any other `@tag` is a DocstringParsingError. */
const NATSPEC_TAGS = new Set(["title", "author", "notice", "dev", "param", "return", "inheritdoc"]);

/**
 * Comments become `///` NatSpec, which solc parses: an unknown tag fails the
 * build. JSDoc habits are translated rather than passed through -- `@returns`
 * is `@return`, `@view` / `@pure` / `@payable` (read as mutability, see
 * `interfaceMutability`) are dropped, and any other tag becomes a
 * `@custom:` tag, which solc accepts and keeps in the devdoc.
 */
function sanitizeNatspec(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const fixed = line
      .replace(/(^|\s)@(view|pure|payable)\b/g, "$1")
      .replace(/(^|\s)@returns\b/g, "$1@return")
      .replace(/(^|\s)@([A-Za-z][\w-]*)/g, (m, pre: string, tag: string) =>
        NATSPEC_TAGS.has(tag) || tag.startsWith("custom") ? m : `${pre}@custom:${tag.toLowerCase().replace(/[^a-z-]/g, "-")}`)
      .trimEnd();
    if (fixed.trim() !== "" || line.trim() === "") out.push(fixed);
  }
  // Leading / trailing blank lines left behind by a dropped tag.
  while (out.length > 0 && out[0]!.trim() === "") out.shift();
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  return out;
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

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Members that carry no contract meaning, so silence about them is correct. */
function isIgnorableMember(m: ts.ClassElement): boolean {
  return ts.isSemicolonClassElement(m) || ts.isClassStaticBlockDeclaration(m);
}

/**
 * TypeScript's own visibility keywords, which the decorator table never saw:
 * `private helper()` was emitted `public` and became part of the external ABI.
 * `protected` is Solidity's `internal`. Returns undefined when none is written.
 */
function visibilityModifier(node: ts.Node, ctx: ParseContext): "public" | "internal" | "private" | undefined {
  if (!ts.canHaveModifiers(node)) return undefined;
  for (const m of ts.getModifiers(node) ?? []) {
    if (m.kind === ts.SyntaxKind.PrivateKeyword) return "private";
    if (m.kind === ts.SyntaxKind.ProtectedKeyword) return "internal";
    if (m.kind === ts.SyntaxKind.PublicKeyword) return "public";
  }
  return undefined;
}

/** `static` has no contract meaning: the member would silently become contract state. */
function reportStatic(node: ts.Node, name: string, ctx: ParseContext): void {
  if (!ts.canHaveModifiers(node)) return;
  if ((ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) {
    ctx.diagnostics.push({
      message: `"${name}" is static; a contract has no static members, and it would be emitted as contract state`,
      loc: loc(node, ctx),
    });
  }
}

function parseStateVar(prop: ts.PropertyDeclaration, ctx: ParseContext): IRStateVar {
  const name = prop.name.getText(ctx.sourceFile);
  const type = prop.type ? parseType(prop.type, ctx) : { kind: "custom", name: "unknown" } as IRType;
  const decorators = parseDecorators(prop, ctx);
  const initializer = prop.initializer ? parseExpression(prop.initializer, ctx) : undefined;
  reportStatic(prop, name, ctx);
  return {
    name,
    type,
    decorators,
    initializer,
    // A decorator wins over a keyword, as it does on methods.
    visibility: (decorators.find((d) => d.name === "public" || d.name === "private" || d.name === "internal")?.name as IRStateVar["visibility"]) ?? visibilityModifier(prop, ctx),
    natspec: extractNatspec(prop, ctx),
    loc: loc(prop, ctx),
  };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

/**
 * Solidity's special functions, recognised by name the way Solidity itself
 * recognises them. `receive` is always `external payable`; `fallback` is
 * `external`, and `payable` only with `@payable`.
 */
function specialKind(name: string, decorators: IRDecorator[]): IRFunction["special"] {
  if (decorators.some((d) => d.name === "modifier")) return "modifier";
  if (name === "receive") return "receive";
  if (name === "fallback") return "fallback";
  return undefined;
}

function parseMethod(method: ts.MethodDeclaration, ctx: ParseContext): IRFunction {
  const name = method.name.getText(ctx.sourceFile);
  const params = method.parameters.map((p) => parseParam(p, ctx));
  const returnType = method.type ? parseType(method.type, ctx) : { kind: "primitive", name: "void" } as IRType;
  // A visibility keyword becomes a decorator so that every consumer -- the
  // emitter, the fuzz generator, the calldata pass -- sees it the one way they
  // already understand. It goes first, so an explicit decorator still wins.
  const modifier = visibilityModifier(method, ctx);
  const decorators = [
    ...(modifier ? [{ name: modifier, args: [] }] : []),
    ...parseDecorators(method, ctx),
  ];
  reportStatic(method, name, ctx);
  const isAbstract = !method.body && hasModifier(method, ts.SyntaxKind.AbstractKeyword);
  // TypeScript rejects a decorator on an abstract method (TS1249), so its
  // mutability comes from the doc comment, as on an interface method.
  if (isAbstract && !decorators.some((d) => d.name === "view" || d.name === "pure" || d.name === "payable")) {
    const tag = interfaceMutability(method, ctx);
    if (tag) decorators.push({ name: tag, args: [] });
  }
  if (!method.body && !isAbstract) {
    // A TS overload signature. Solidity overloads are separate functions with
    // separate bodies, which a TS class cannot express.
    ctx.diagnostics.push({
      message: `method "${name}" has no body; mark it \`abstract\` (in an \`abstract class\`) for a Solidity virtual function, or give it one. TS overload signatures have no Solidity equivalent`,
      loc: loc(method, ctx),
    });
  }
  ctx.returnType = returnType;
  const body = method.body ? parseBlockBody(method.body, ctx) : [];
  ctx.returnType = undefined;
  const special = specialKind(name, decorators);
  if ((special === "receive" || special === "fallback") && (params.length > 0 || !(returnType.kind === "primitive" && returnType.name === "void"))) {
    ctx.diagnostics.push({
      message: `${name}() takes no parameters and returns nothing in Solidity; read msg.data for the calldata`,
      loc: loc(method, ctx),
    });
  }

  const isAssembly = decorators.some((d) => d.name === "assembly");
  let assemblyBody: string | undefined;
  if (isAssembly && method.body) {
    assemblyBody = extractAssemblyBody(method.body, ctx);
  }

  return {
    name,
    isConstructor: false,
    special,
    isAbstract: isAbstract || undefined,
    isOverride: hasModifier(method, ts.SyntaxKind.OverrideKeyword) || undefined,
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
  // Solidity has none of these, and dropping them changed the function's
  // interface without saying so: an optional parameter became required, a
  // default vanished, and a rest parameter became a single array argument.
  if (param.questionToken) {
    ctx.diagnostics.push({ message: `parameter "${name}" is optional; Solidity has no optional parameters, so it would become required`, loc: loc(param, ctx) });
  }
  if (param.initializer) {
    ctx.diagnostics.push({ message: `parameter "${name}" has a default value; Solidity has no default arguments, so the default would be dropped`, loc: loc(param, ctx) });
  }
  if (param.dotDotDotToken) {
    ctx.diagnostics.push({ message: `parameter "${name}" is a rest parameter; Solidity has no variadics — declare it as an array parameter and pass one argument`, loc: loc(param, ctx) });
  }
  if (ts.canHaveModifiers(param) && (ts.getModifiers(param) ?? []).length > 0) {
    ctx.diagnostics.push({ message: `parameter "${name}" is a parameter property; declare the state variable on the class instead`, loc: loc(param, ctx) });
  }
  return { name, type };
}

/**
 * `public` and `private` are reserved words in TypeScript, so the package
 * exports them as `public_` / `private_`. The rest of the pipeline knows the
 * Solidity spelling only; without this a `@private_` helper was silently
 * emitted `public`.
 */
const DECORATOR_ALIASES: Record<string, string> = { public_: "public", private_: "private" };

function parseDecorators(node: ts.HasDecorators, ctx: ParseContext): IRDecorator[] {
  if (!ts.canHaveDecorators(node)) return [];
  const decs = ts.getDecorators(node) ?? [];
  return decs.map((d) => {
    if (ts.isCallExpression(d.expression)) {
      const name = d.expression.expression.getText(ctx.sourceFile);
      return {
        name: DECORATOR_ALIASES[name] ?? name,
        args: d.expression.arguments.map((a) => parseExpression(a, ctx)),
      };
    }
    const name = d.expression.getText(ctx.sourceFile);
    return { name: DECORATOR_ALIASES[name] ?? name, args: [] };
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

/**
 * Register a file-level `interface` / object `type` as a struct -- but only if
 * it actually describes one.
 *
 * A file may legitimately declare interfaces that are not structs at all (a
 * callback shape, a type for a TS consumer). Emitting `struct IFoo {}` for
 * those produces Solidity solc rejects, so an declaration with no struct
 * fields is quietly not a struct. One that has fields *and* members that
 * cannot be lowered is reported and left unregistered, rather than emitted as
 * a half-struct that silently drops state.
 */
/**
 * The structural half of registerStruct's decision, answerable before any
 * field type is parsed: at least one typed property, and nothing a struct
 * cannot hold. Used to reserve the name so other structs can refer to it.
 */
function isStructShaped(members: ts.NodeArray<ts.TypeElement>): boolean {
  return members.length > 0 && members.every((m) => ts.isPropertySignature(m) && m.type !== undefined && !m.questionToken);
}

function registerStruct(
  name: string,
  members: ts.NodeArray<ts.TypeElement>,
  node: ts.Node,
  ctx: ParseContext,
): void {
  const { decl, problems } = parseStructDecl(name, members, node, ctx);
  if (decl.fields.length === 0) { ctx.structs.delete(name); return; } // not a struct: nothing to lower, and nothing to complain about
  if (problems.length > 0) {
    for (const p of problems) ctx.diagnostics.push(p);
    ctx.structs.delete(name);
    return;
  }
  ctx.structs.set(decl.name, decl);
}

function parseStructDecl(
  name: string,
  members: ts.NodeArray<ts.TypeElement>,
  node: ts.Node,
  ctx: ParseContext,
): { decl: IRStructDecl; problems: ParseDiagnostic[] } {
  const fields: IRParam[] = [];
  const problems: ParseDiagnostic[] = [];
  for (const m of members) {
    if (!ts.isPropertySignature(m) || !m.type) {
      problems.push({
        message: `struct ${name}: only typed property fields are supported (methods, index signatures and call signatures have no Solidity equivalent)`,
        loc: loc(m, ctx),
      });
      continue;
    }
    if (m.questionToken) {
      problems.push({ message: `struct ${name}.${m.name.getText(ctx.sourceFile)}: Solidity struct fields cannot be optional`, loc: loc(m, ctx) });
    }
    fields.push({ name: m.name.getText(ctx.sourceFile), type: parseType(m.type, ctx) });
  }
  return { decl: { name, fields, natspec: extractNatspec(node, ctx), loc: loc(node, ctx) }, problems };
}

/**
 * A TS interface made only of required method signatures: a candidate
 * Solidity `interface`. It is emitted only if the build uses it (see
 * `emitProgram`), so a TS-only callback shape stays TS-only.
 */
function isInterfaceShaped(members: ts.NodeArray<ts.TypeElement>): boolean {
  return members.length > 0 && members.every((m) => ts.isMethodSignature(m) && !m.questionToken);
}

/**
 * Mutability is part of an interface function's signature -- calling a
 * non-`view` one from a `view` function does not compile -- but a TS method
 * signature cannot carry a decorator. It is read from the doc comment instead:
 * `/** @view *\/ balanceOf(a: Address): bigint;`.
 */
const INTERFACE_MUTABILITY = /(?:^|\s)@(view|pure|payable)\b/;

/**
 * The `@view` / `@pure` / `@payable` tag in the doc comment right before an
 * interface method. Read from the member's own trivia rather than its leading
 * comments or JSDoc: on a one-line interface, TS files
 * `f(): T; /** @view *\/ g(): U;` as a trailing comment of `f` and gives `g`
 * no JSDoc at all.
 */
function interfaceMutability(m: ts.TypeElement | ts.MethodDeclaration, ctx: ParseContext): string | undefined {
  const trivia = ctx.sourceFile.text.slice(m.getFullStart(), m.getStart(ctx.sourceFile));
  const docs = trivia.match(/\/\*\*[\s\S]*?\*\//g);
  const last = docs?.[docs.length - 1];
  return last ? INTERFACE_MUTABILITY.exec(last.replace(/^\/\*\*|\*\/$/g, ""))?.[1] : undefined;
}

function parseInterfaceDecl(node: ts.InterfaceDeclaration, ctx: ParseContext): IRInterface {
  const functions: IRFunction[] = [];
  for (const m of node.members) {
    if (!ts.isMethodSignature(m)) continue;
    const name = m.name.getText(ctx.sourceFile);
    const natspec = extractNatspec(m, ctx);
    const tag = interfaceMutability(m, ctx);
    functions.push({
      name,
      isConstructor: false,
      isAbstract: true,
      decorators: tag ? [{ name: tag, args: [] }] : [],
      params: m.parameters.map((p) => parseParam(p, ctx)),
      returnType: m.type ? parseType(m.type, ctx) : { kind: "primitive", name: "void" },
      body: [],
      natspec,
      loc: loc(m, ctx),
    });
  }
  return { name: node.name.text, functions, events: [], sourceFile: ctx.filePath, natspec: extractNatspec(node, ctx), loc: loc(node, ctx) };
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
    if (name === "FixedArray" && args.length === 2) {
      // `FixedArray<bigint, 3>` → `uint256[3]`.
      const n = args[1]!;
      const len = ts.isLiteralTypeNode(n) && ts.isNumericLiteral(n.literal) ? Number(n.literal.text) : NaN;
      if (!Number.isInteger(len) || len < 1) {
        ctx.diagnostics.push({ message: `FixedArray length must be a positive integer literal, not "${n.getText(ctx.sourceFile)}"`, loc: loc(n, ctx) });
        return { kind: "array", element: parseType(args[0]!, ctx) };
      }
      return { kind: "array", element: parseType(args[0]!, ctx), length: len };
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
  if (ts.isTupleTypeNode(typeNode)) {
    // `[bigint, boolean]` → `(uint256, bool)`: several return values.
    return { kind: "tuple", elements: typeNode.elements.map((t) => parseType(ts.isNamedTupleMember(t) ? t.type : t, ctx)) };
  }
  if (ts.isParenthesizedTypeNode(typeNode)) return parseType(typeNode.type, ctx);
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
    eventName: declaredName(arg.expression, ctx),
    args: arg.arguments.map((a) => parseExpression(a, ctx)),
    loc: l,
  };
}

/**
 * The name of an event or error as written at an `emit` / `revert`: `Transfer`
 * or `this.Transfer`. Events and errors are declared as methods, so
 * `this.Transfer(...)` is the spelling TypeScript itself accepts.
 */
function declaredName(callee: ts.Expression, ctx: ParseContext): string {
  if (ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword) return callee.name.text;
  return callee.getText(ctx.sourceFile);
}

/**
 * `throw new Error("msg")` is `revert("msg")`, and throwing a declared error
 * (`throw new TooLow(a)`, `throw this.TooLow(a)`) is `revert TooLow(a)`.
 * Lowering every throw to a bare `revert()` dropped the reason.
 */
function parseThrow(stmt: ts.ThrowStatement, ctx: ParseContext, l: SourceLocation): IRStatement {
  const arg = stmt.expression;
  const callee = ts.isNewExpression(arg) || ts.isCallExpression(arg) ? arg.expression : undefined;
  const args = (ts.isNewExpression(arg) || ts.isCallExpression(arg) ? arg.arguments ?? [] : []).map((a) => parseExpression(a, ctx));
  if (callee && ts.isIdentifier(callee) && callee.text === "Error") {
    if (args.length > 1) ctx.diagnostics.push({ message: "`throw new Error(...)` takes at most one argument, the revert reason", loc: l });
    return { kind: "expression", expr: { kind: "call", callee: { kind: "identifier", name: "revert" }, args: args.slice(0, 1) }, loc: l };
  }
  if (callee && (ts.isIdentifier(callee) || (ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword))) {
    return { kind: "revert", errorName: declaredName(callee, ctx), args, loc: l };
  }
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return { kind: "expression", expr: { kind: "call", callee: { kind: "identifier", name: "revert" }, args: [parseExpression(arg, ctx)] }, loc: l };
  }
  ctx.diagnostics.push({
    message: "`throw` needs `new Error(\"reason\")` or a declared error (`throw new TooLow(a)`); Solidity cannot revert with an arbitrary value",
    loc: l,
  });
  return { kind: "throw", argument: parseExpression(arg, ctx), loc: l };
}

/**
 * `unchecked(() => { … })` is Solidity's `unchecked { … }` block: arithmetic
 * inside it wraps instead of reverting. Only a block-bodied arrow is accepted,
 * so the statements are exactly the ones written.
 */
function tryParseUnchecked(expr: ts.Expression, ctx: ParseContext, l: SourceLocation): IRStatement | undefined {
  if (!ts.isCallExpression(expr) || !ts.isIdentifier(expr.expression) || expr.expression.text !== "unchecked") return undefined;
  const [fn] = expr.arguments;
  if (expr.arguments.length !== 1 || !fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || !ts.isBlock(fn.body) || fn.parameters.length > 0) {
    ctx.diagnostics.push({ message: "`unchecked` takes one argument, a block: `unchecked(() => { … })`", loc: l });
    return { kind: "unchecked", body: [], loc: l };
  }
  return { kind: "unchecked", body: parseBlockBody(fn.body, ctx), loc: l };
}

/**
 * Solidity's `try` works on exactly one external call (or `new`), and its
 * success block sees that call's return values. The TS spelling is a `try`
 * whose first statement is that call:
 *
 *   try { const bal = at<IERC20>(t).balanceOf(a); … } catch { … }
 *   → try IERC20(t).balanceOf(a) returns (uint256 bal) { … } catch { … }
 *
 * `catch (e)` binds the revert data: `catch (bytes memory e)`.
 */
function parseTry(stmt: ts.TryStatement, ctx: ParseContext, l: SourceLocation): IRStatement {
  const fail = (message: string): IRStatement => {
    ctx.diagnostics.push({ message, loc: l });
    return { kind: "raw", text: stmt.getText(ctx.sourceFile), loc: l };
  };
  if (stmt.finallyBlock) return fail("`finally` has no Solidity equivalent; put the code after the try / catch");
  if (!stmt.catchClause) return fail("Solidity's `try` needs a `catch`");
  const [first, ...rest] = stmt.tryBlock.statements;
  if (!first) return fail("the `try` block is empty; its first statement must be the external call being tried");

  let callNode: ts.Expression | undefined;
  const returns: IRParam[] = [];
  const body: IRStatement[] = [];
  if (ts.isVariableStatement(first) && first.declarationList.declarations.length === 1) {
    const d = first.declarationList.declarations[0]!;
    callNode = d.initializer;
    if (ts.isIdentifier(d.name)) {
      returns.push({ name: d.name.text, type: d.type ? parseType(d.type, ctx) : { kind: "custom", name: "unknown" } });
    } else if (ts.isArrayBindingPattern(d.name)) {
      const types = d.type && ts.isTupleTypeNode(d.type) ? d.type.elements.map((t) => parseType(ts.isNamedTupleMember(t) ? t.type : t, ctx)) : [];
      d.name.elements.forEach((el, i) => {
        const type = types[i] ?? { kind: "custom", name: "unknown" } as IRType;
        returns.push({ name: ts.isBindingElement(el) && ts.isIdentifier(el.name) ? el.name.text : "", type });
      });
    }
  } else if (ts.isExpressionStatement(first)) {
    callNode = first.expression;
  } else if (ts.isReturnStatement(first) && first.expression) {
    // `try { return I(t).f(); }` → `try I(t).f() returns (T r) { return r; }`.
    callNode = first.expression;
    const r = "__tryResult";
    returns.push({ name: r, type: ctx.returnType ?? { kind: "custom", name: "unknown" } });
    body.push({ kind: "return", value: { kind: "identifier", name: r }, loc: l });
  }
  if (!callNode || !(ts.isCallExpression(callNode) || ts.isNewExpression(callNode))) {
    return fail("the first statement of a `try` block must be the external call (or `new`) being tried: `const r = at<IFoo>(addr).f()`, `at<IFoo>(addr).f();` or `return …`");
  }
  const call = parseExpression(callNode, ctx);
  body.push(...rest.map((st) => parseStatement(st, ctx)));

  const cc = stmt.catchClause;
  const param = cc.variableDeclaration && ts.isIdentifier(cc.variableDeclaration.name) ? cc.variableDeclaration.name.text : undefined;
  const catchBody = parseBlockBody(cc.block, ctx);
  const catches: IRCatchClause[] = [param ? { kind: "bytes", param, body: catchBody } : { kind: "any", body: catchBody }];
  return { kind: "try", call, returns, body, catches, loc: l };
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
    errorName: declaredName(arg.expression, ctx),
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
    const unchecked = tryParseUnchecked(stmt.expression, ctx, l);
    if (unchecked) return unchecked;
    return { kind: "expression", expr: parseExpression(stmt.expression, ctx), loc: l };
  }
  if (ts.isReturnStatement(stmt)) {
    if (stmt.expression && ts.isArrayLiteralExpression(stmt.expression) && ctx.returnType?.kind === "tuple") {
      return { kind: "return", value: parseTuple(stmt.expression, ctx), loc: l };
    }
    return { kind: "return", value: stmt.expression ? parseExpression(stmt.expression, ctx) : undefined, loc: l };
  }
  if (ts.isDoStatement(stmt)) {
    return {
      kind: "while",
      doWhile: true,
      test: parseExpression(stmt.expression, ctx),
      body: branchToStatements(stmt.statement, ctx),
      loc: l,
    };
  }
  if (ts.isTryStatement(stmt)) return parseTry(stmt, ctx, l);
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
    if (first && ts.isArrayBindingPattern(first.name)) {
      if (!first.initializer) {
        ctx.diagnostics.push({ message: "destructuring declaration needs an initializer", loc: l });
        return { kind: "raw", text: stmt.getText(ctx.sourceFile), loc: l };
      }
      const names: Array<string | undefined> = [];
      for (const el of first.name.elements) {
        if (!ts.isBindingElement(el)) { names.push(undefined); continue; } // `const [, b] = ...`
        if (el.dotDotDotToken) {
          ctx.diagnostics.push({ message: "rest element in a destructuring declaration is not supported; Solidity tuple assignment has a fixed arity, so name each component", loc: loc(el, ctx) });
          names.push(undefined);
          continue;
        }
        if (el.initializer) {
          ctx.diagnostics.push({ message: `default value for "${el.name.getText(ctx.sourceFile)}" in a destructuring declaration is not supported; Solidity tuple assignment has no defaults`, loc: loc(el, ctx) });
        }
        if (!ts.isIdentifier(el.name)) {
          ctx.diagnostics.push({ message: "nested destructuring pattern is not supported; destructure one level and index the parts separately", loc: loc(el, ctx) });
          names.push(undefined);
          continue;
        }
        names.push(el.name.text);
      }
      const types = first.type && ts.isTupleTypeNode(first.type)
        ? first.type.elements.map((t) => parseType(ts.isNamedTupleMember(t) ? t.type : t, ctx))
        : undefined;
      return {
        kind: "destructure",
        names,
        types,
        init: ts.isArrayLiteralExpression(first.initializer) ? parseTuple(first.initializer, ctx) : parseExpression(first.initializer, ctx),
        isConst: (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0,
        loc: l,
      };
    }
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
  if (ts.isThrowStatement(stmt)) return parseThrow(stmt, ctx, l);
  if (ts.isBreakStatement(stmt)) return { kind: "break", loc: l };
  if (ts.isContinueStatement(stmt)) return { kind: "continue", loc: l };
  if (stmt.kind === ts.SyntaxKind.EmptyStatement) return { kind: "block", body: [], loc: l };
  // Anything left would be emitted as its TypeScript text: `1n` literals and
  // un-rewritten `this.` reaching solc, which then reports a parse error
  // against generated Solidity the developer never wrote.
  ctx.diagnostics.push({
    message: `${statementName(stmt)} has no Solidity equivalent and cannot be emitted`,
    loc: l,
  });
  return { kind: "raw", text: stmt.getText(ctx.sourceFile), loc: l };
}

const EXPRESSION_NAMES: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.TypeOfExpression]: "`typeof`",
  [ts.SyntaxKind.AwaitExpression]: "`await`",
  [ts.SyntaxKind.ArrowFunction]: "an arrow function",
  [ts.SyntaxKind.FunctionExpression]: "a function expression",
  [ts.SyntaxKind.SpreadElement]: "a spread element",
  [ts.SyntaxKind.NullKeyword]: "`null`",
  [ts.SyntaxKind.RegularExpressionLiteral]: "a regular expression",
  [ts.SyntaxKind.VoidExpression]: "`void`",
  [ts.SyntaxKind.ClassExpression]: "a class expression",
  [ts.SyntaxKind.DeleteExpression]: "`delete` on a property",
};

function expressionName(expr: ts.Expression): string {
  return EXPRESSION_NAMES[expr.kind] ?? `an expression of kind ${ts.SyntaxKind[expr.kind]}`;
}

const STATEMENT_NAMES: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.SwitchStatement]: "a `switch` statement",
  [ts.SyntaxKind.ForOfStatement]: "a `for … of` loop",
  [ts.SyntaxKind.ForInStatement]: "a `for … in` loop",
  [ts.SyntaxKind.LabeledStatement]: "a labelled statement",
  [ts.SyntaxKind.WithStatement]: "a `with` block",
  [ts.SyntaxKind.FunctionDeclaration]: "a nested function declaration",
  [ts.SyntaxKind.ClassDeclaration]: "a nested class declaration",
};

function statementName(stmt: ts.Statement): string {
  return STATEMENT_NAMES[stmt.kind] ?? `a statement of kind ${ts.SyntaxKind[stmt.kind]}`;
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
    if (ts.isAsExpression(expr)) return parseCast(expr, ctx);
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
  if (ts.isIdentifier(expr)) {
    if (expr.text === "undefined") {
      ctx.diagnostics.push({ message: "`undefined` has no Solidity equivalent; a storage read already yields the type's default", loc: loc(expr, ctx) });
    }
    return { kind: "identifier", name: expr.text };
  }
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
  if (ts.isCallExpression(expr)) return parseCall(expr, ctx);
  if (ts.isNewExpression(expr)) {
    const className = expr.expression.getText(ctx.sourceFile);
    const args = (expr.arguments ?? []).map((a) => parseExpression(a, ctx));
    if (className === "Array" && expr.typeArguments?.length === 1) {
      // `new Array<bigint>(n)` → `new uint256[](n)`, a memory array of length n.
      const type: IRType = { kind: "array", element: parseType(expr.typeArguments[0]!, ctx) };
      if (args.length !== 1) ctx.diagnostics.push({ message: "`new Array<T>(n)` takes exactly one argument, the length", loc: loc(expr, ctx) });
      return { kind: "new", className, args, type };
    }
    return { kind: "new", className, args };
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isArrayLiteralExpression(expr.left)) {
    // `[a, b] = [b, a]` / `[x, y] = this.pair()` → `(a, b) = (b, a)`.
    const right = ts.isArrayLiteralExpression(expr.right) ? parseTuple(expr.right, ctx) : parseExpression(expr.right, ctx);
    return { kind: "assign", op: "=", left: parseTuple(expr.left, ctx), right };
  }
  if (ts.isBinaryExpression(expr)) {
    const opText = expr.operatorToken.getText(ctx.sourceFile);
    const left = parseExpression(expr.left, ctx);
    const right = parseExpression(expr.right, ctx);
    if (opText === "??") return { kind: "nullish", left, right };
    if (opText.endsWith("=") && !["==", "!=", "===", "!==", "<=", ">="].includes(opText)) {
      if (!SUPPORTED_ASSIGN_OPS.has(opText)) {
        ctx.diagnostics.push({ message: `the "${opText}" operator has no Solidity equivalent`, loc: loc(expr, ctx) });
      }
      return { kind: "assign", op: opText, left, right };
    }
    if (!SUPPORTED_BINARY_OPS.has(opText)) {
      // `instanceof`, `in`, `>>>` would each be emitted verbatim.
      ctx.diagnostics.push({ message: `the "${opText}" operator has no Solidity equivalent`, loc: loc(expr, ctx) });
    }
    return { kind: "binary", op: opText, left, right };
  }
  if (ts.isDeleteExpression(expr)) {
    // `delete xs[0]` is Solidity's own `delete`, not a TS property removal.
    return { kind: "unary", op: "delete", operand: parseExpression(expr.expression, ctx), prefix: true };
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
  if (ts.isArrayLiteralExpression(expr)) {
    // `[]` is how an array state variable is initialised, and the emitter drops
    // that initializer, so it is not an error. A populated one would be emitted
    // as its TypeScript text, `1n` and all.
    if (expr.elements.length > 0) {
      ctx.diagnostics.push({
        message: "an array literal has no Solidity equivalent; assign elements individually, or `push` them",
        loc: loc(expr, ctx),
      });
    }
    return { kind: "raw", text: "[]" };
  }
  // Anything left would reach solc as TypeScript text.
  ctx.diagnostics.push({
    message: `${expressionName(expr)} has no Solidity equivalent and cannot be emitted`,
    loc: loc(expr, ctx),
  });
  return { kind: "raw", text: expr.getText(ctx.sourceFile) };
}

/**
 * `[a, b]` where Solidity has a tuple: a `return` from a function with a tuple
 * return type, and either side of a tuple assignment. A hole (`[a, , c]`)
 * stays empty, as it does in Solidity.
 */
function parseTuple(expr: ts.ArrayLiteralExpression, ctx: ParseContext): IRExpression {
  return {
    kind: "tuple",
    elements: expr.elements.map((e) => (ts.isOmittedExpression(e) ? undefined : parseExpression(e, ctx))),
  };
}

/** Solidity's elementary type names that a TS cast can target with an explicit conversion. */
const CONVERTIBLE = /^(u?int\d+|bytes\d+|address)$/;

/**
 * `x as Uint8`. TypeScript erases the cast; Solidity needs it spelled out
 * whenever it narrows (`uint8(x)`), and rejects the assignment otherwise. The
 * parser keeps the target type; the emitter writes the conversion only when
 * the operand's type is known to differ, so `(votes + 1n) as Uint64` stays
 * `votes + 1` when `votes` is already a `uint64`.
 *
 * A literal needs no conversion (`51n as Uint8` is `51`), except a hex string
 * cast to a fixed-size byte type: `"0xdeadbeef" as Bytes4` is the literal
 * `0xdeadbeef`, which Solidity accepts for a `bytes4` of exactly that width.
 */
function parseCast(expr: ts.AsExpression, ctx: ParseContext): IRExpression {
  const inner = parseExpression(expr.expression, ctx);
  const t = parseType(expr.type, ctx);
  const prim = t.kind === "primitive" ? t.name : undefined;
  if (inner.kind === "literal" && inner.literalType === "string" && prim) {
    const hex = /^0x([0-9a-fA-F]*)$/.exec(inner.value);
    const width = /^bytes(\d+)$/.exec(prim);
    if (hex && width && hex[1]!.length === Number(width[1]) * 2) return { kind: "raw", text: inner.value };
    if (hex && prim === "bytes" && hex[1]!.length % 2 === 0) return { kind: "raw", text: `hex"${hex[1]}"` };
    if (width || prim === "bytes") {
      ctx.diagnostics.push({
        message: `"${inner.value}" as ${expr.type.getText(ctx.sourceFile)}: a byte literal is written as hex, with exactly ${width ? Number(width[1]) * 2 : "an even number of"} hex digits after 0x`,
        loc: loc(expr, ctx),
      });
    }
    return inner;
  }
  // Only a branded type asks for a conversion: `x as bigint` is TypeScript's
  // way of saying "treat this as a number", not Solidity's `uint256(x)`.
  const branded = ts.isTypeReferenceNode(expr.type);
  if (isLiteralish(inner) || !branded || !prim || !CONVERTIBLE.test(prim)) return inner;
  return { kind: "call", callee: { kind: "identifier", name: prim }, args: [inner], typeArgs: [t], cast: true } as IRExpression;
}

/** A literal, or a negated one: Solidity converts these implicitly when they fit. */
function isLiteralish(e: IRExpression): boolean {
  if (e.kind === "paren") return isLiteralish(e.inner);
  if (e.kind === "unary" && e.op === "-") return isLiteralish(e.operand);
  return e.kind === "literal";
}

/** Keys Solidity accepts in a call-options block `{value: …, gas: …, salt: …}`. */
const CALL_OPTION_KEYS = new Set(["value", "gas"]);
const LOW_LEVEL = new Set(["call", "delegatecall", "staticcall"]);

/**
 * JavaScript's standard library, which a contract cannot call: `Math.max(a, b)`
 * reached solc as an undeclared identifier. (`console` is left alone: forge-std
 * provides `console.log` to tests.)
 */
const JS_BUILTINS = new Set(["Math", "JSON", "Date", "Object", "Reflect", "Promise", "Symbol", "String", "Array", "Number", "BigInt", "parseInt", "parseFloat"]);

function parseCall(expr: ts.CallExpression, ctx: ParseContext): IRExpression {
  const callee = expr.expression;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && JS_BUILTINS.has(callee.expression.text)) {
    ctx.diagnostics.push({
      message: `\`${callee.getText(ctx.sourceFile)}\` is JavaScript's standard library, which does not exist on-chain; write the logic out (e.g. \`a > b ? a : b\` for Math.max)`,
      loc: loc(expr, ctx),
    });
  }
  const typeArgs = expr.typeArguments?.map((t) => parseType(t, ctx));
  if (ts.isIdentifier(callee)) {
    const name = callee.text;
    if ((name === "Number" || name === "BigInt") && expr.arguments.length === 1) {
      // A widening to uint256 when the operand is narrower (an enum, a uint8);
      // the emitter drops it when the operand already is one.
      return { kind: "call", callee: { kind: "identifier", name: "BigInt" }, args: [parseExpression(expr.arguments[0]!, ctx)] };
    }
    if (name === "at") {
      // `at<IERC20>(token)` → `IERC20(token)`: the contract at an address, typed.
      const target = expr.typeArguments?.[0];
      if (!target || !ts.isTypeReferenceNode(target) || expr.arguments.length !== 1) {
        ctx.diagnostics.push({ message: "`at` takes one type argument and one address: `at<IERC20>(token)`", loc: loc(expr, ctx) });
      } else {
        return { kind: "call", callee: { kind: "identifier", name: target.typeName.getText(ctx.sourceFile) }, args: [parseExpression(expr.arguments[0]!, ctx)] };
      }
    }
    if (name === "type" && expr.arguments.length === 0 && typeArgs?.length === 1) {
      // `type<Uint64>().max`, `type<IERC20>().interfaceId`.
      return { kind: "call", callee: { kind: "identifier", name: "type" }, args: [], typeArgs };
    }
  }
  const args = expr.arguments.map((a) => parseExpression(a, ctx));
  // `to.call({ value: v }, data)` → `to.call{value: v}(data)`. Only the
  // low-level calls take an options object this way, so a struct argument to
  // any other function is never mistaken for one.
  if (ts.isPropertyAccessExpression(callee) && LOW_LEVEL.has(callee.name.text) && expr.arguments.length === 2) {
    const first = expr.arguments[0]!;
    if (ts.isObjectLiteralExpression(first) && first.properties.every((p) => ts.isPropertyAssignment(p) && CALL_OPTION_KEYS.has(p.name.getText(ctx.sourceFile)))) {
      const options = first.properties.map((p) => ({ name: p.name!.getText(ctx.sourceFile), value: parseExpression((p as ts.PropertyAssignment).initializer, ctx) }));
      return { kind: "call", callee: parseExpression(callee, ctx), args: args.slice(1), options };
    }
  }
  const out: IRExpression = { kind: "call", callee: parseExpression(callee, ctx), args };
  if (typeArgs && typeArgs.length > 0) out.typeArgs = typeArgs;
  return out;
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

  // A literal that already names its struct (`{ … } as Proposal`) still needs
  // its nested literals typed, whether or not the slot it flows into is typed.
  const expect = (e: IRExpression | undefined, t: IRType | undefined): void => {
    if (!e) return;
    const inner = e.kind === "paren" ? e.inner : e;
    if (inner.kind !== "object") return;
    if (t?.kind === "struct") inner.structName ??= t.name;
    if (!inner.structName) return;
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
        if (e.kind === "object" && e.structName) expect(e, undefined);
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

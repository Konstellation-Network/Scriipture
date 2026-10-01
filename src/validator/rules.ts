import path from "node:path";
import type {
  IRContract,
  IRExpression,
  IRFunction,
  IRProgram,
  IRStatement,
  SourceLocation,
} from "../ir/types";
import { FUNCTION_DECORATORS, SAFETY_OVERRIDE_DECORATORS, resolveContract, standardImportFor } from "../mapper/decorators";
import { paramReference, userModifierNames } from "../emitter/emit";
import { ancestorsOf } from "../mapper/lineage";
import type { Diagnostic } from "./diagnostics";
import { getPluginDecorators, getPluginValidatorRules } from "../plugin/api";
import { isSolidityReserved } from "./reserved";
import { walkStatements, walkExpressionsInStatement, walkExpr } from "../optimizer/walk";
import { destructureShapeKnown, emptinessTest, hasSideEffects, inferType, isLowLevelCall, isZeroLiteral, mixesStorageAndMemory, typeEnvFor, walkScoped } from "../mapper/infer";

/**
 * Every `rule` identifier the native validator can emit. Not every one is an
 * entry in `RULES`: some checks need the whole contract or the whole program.
 * A test asserts this list matches the source, so the count quoted in the docs
 * cannot drift away from the code again.
 */
export const RULE_IDS = [
  "constructor-no-decorators",
  "destructure-shape",
  "event-too-many-indexed",
  "integer-division",
  "no-arbitrary-call-target",
  "no-block-timestamp-randomness",
  "no-delegatecall-to-input",
  "no-msg-value-in-non-payable",
  "no-selfdestruct",
  "no-shadowed-state",
  "no-transfer-in-loop",
  "no-tx-origin",
  "no-unchecked-low-level-call",
  "no-zero-address-mint",
  "nullish-fallback",
  "payable-visibility",
  "pure-no-mutate",
  "require-checked-address",
  "solidity-reserved-identifier",
  "state-mutation-without-event",
  "storage-alias",
  "unbounded-loop",
  "undeclared-error",
  "undeclared-event",
  "unknown-base-contract",
  "unknown-decorator",
  "value-type-unwrap",
  "view-no-mutate",
] as const;

type Rule = (contract: IRContract, fn: IRFunction, program?: IRProgram) => Diagnostic[];

export interface ValidateOptions {
  secure?: boolean;
}

export function validateProgram(program: IRProgram, opts: ValidateOptions = {}): Diagnostic[] {
  const out: Diagnostic[] = [];
  const known = new Set(program.contracts.map((c) => c.name));
  const interfaces = new Set((program.interfaces ?? []).map((i) => i.name));
  for (const contract of program.contracts) {
    out.push(...validateContract(contract, opts, program));
    out.push(...ruleUnknownDecorators(contract, program));
    for (const iface of contract.interfaces ?? []) {
      if (interfaces.has(iface)) continue;
      out.push({
        rule: "unknown-base-contract",
        severity: "error",
        message: `"${contract.name}" implements "${iface}", which is not an interface in this build (a file-level TS interface whose members are all methods)`,
        loc: contract.loc,
        fix: `declare \`interface ${iface} { … }\` with method signatures in a file passed to this build`,
      });
    }
    // Needs the whole program, so it cannot live in validateContract.
    for (const base of contract.bases) {
      if (standardImportFor(base) || known.has(base)) continue;
      out.push({
        rule: "unknown-base-contract",
        severity: "error",
        message: `"${contract.name}" extends "${base}", which is neither a contract in this build nor one Scriipture bundles, so the emitted Solidity would not compile`,
        loc: contract.loc,
        fix: `define ${base} in a file passed to this build, or extend one of the bundled bases`,
      });
    }
  }
  // Free functions get the per-function rules too: a `tx.origin` check or an
  // unchecked call is no safer outside a contract.
  for (const scope of program.files ?? []) {
    if (scope.functions.length === 0) continue;
    const pseudo: IRContract = {
      name: path.basename(scope.sourceFile), bases: [], stateVars: [], functions: scope.functions, errors: [], events: [],
      structs: scope.structs, enums: scope.enums, valueTypes: scope.valueTypes, sourceFile: scope.sourceFile,
    };
    for (const fn of scope.functions) {
      for (const rule of RULES) for (const d of rule(pseudo, fn, program)) if (!functionHasAllowFor(fn, d.rule)) out.push(d);
    }
  }
  if (opts.secure) {
    return out.map((d) => applySecureEscalation(d));
  }
  return out;
}

const SECURE_ESCALATE_RULES = new Set([
  "require-checked-address",
  "no-tx-origin",
  "no-selfdestruct",
  "no-zero-address-mint",
  "no-unchecked-low-level-call",
  "no-delegatecall-to-input",
  "no-arbitrary-call-target",
  "no-block-timestamp-randomness",
  "no-transfer-in-loop",
  "view-no-mutate",
  "pure-no-mutate",
  "payable-visibility",
]);

const RULE_TO_ALLOW: Record<string, string> = {
  "require-checked-address": "allowZeroAddress",
  "no-tx-origin": "allowTxOrigin",
  "no-selfdestruct": "allowSelfdestruct",
  "no-zero-address-mint": "allowZeroAddress",
  "no-unchecked-low-level-call": "allowLowLevelCall",
  "no-delegatecall-to-input": "allowLowLevelCall",
  "no-arbitrary-call-target": "allowLowLevelCall",
};

function applySecureEscalation(d: Diagnostic): Diagnostic {
  if (!SECURE_ESCALATE_RULES.has(d.rule)) return d;
  return { ...d, severity: "error", message: `[secure-mode] ${d.message}` };
}

function functionHasAllowFor(fn: { decorators: { name: string }[] }, rule: string): boolean {
  const allow = RULE_TO_ALLOW[rule];
  if (!allow) return false;
  return fn.decorators.some((d) => d.name === allow || d.name === "unsafe");
}

/** Decorators that mean something on a method, beyond the ones in the modifier table. */
const METHOD_DECORATORS = new Set([
  ...Object.keys(FUNCTION_DECORATORS),
  ...SAFETY_OVERRIDE_DECORATORS,
  "solidity", "assembly", "event", "error", "invariant", "throws", "modifier", "virtual", "overload",
]);

/** Decorators that mean something on a state variable. */
const FIELD_DECORATORS = new Set(["storage", "public", "private", "internal", "transient"]);

/**
 * A decorator nothing recognises used to vanish: `@onlyAdmin` on a function
 * with no `@modifier onlyAdmin` shipped the function with no access check at
 * all, and `@private_` on a field shipped it `public`. Every decorator must be
 * one Scriipture lowers, a modifier this contract or a base declares, or one
 * a plugin claims.
 */
function ruleUnknownDecorators(contract: IRContract, program: IRProgram): Diagnostic[] {
  const out: Diagnostic[] = [];
  const modifiers = userModifierNames(contract, program);
  const fromPlugins = new Set(getPluginDecorators());
  const report = (name: string, where: string, loc: SourceLocation | undefined, fix: string): void => {
    out.push({ rule: "unknown-decorator", severity: "error", message: `@${name} on ${where} is not a decorator Scriipture knows, so it would be dropped from the emitted Solidity`, loc, fix });
  };
  for (const fn of contract.functions) {
    for (const d of fn.decorators) {
      // `@onlyCreator(param("id"))` must name one of this function's parameters.
      for (const a of d.args) {
        const ref = paramReference(a);
        if (ref !== undefined && !fn.params.some((p) => p.name === ref)) {
          out.push({
            rule: "unknown-decorator",
            severity: "error",
            message: `@${d.name}(param("${ref}")) on function "${fn.name}": "${ref}" is not one of its parameters`,
            loc: fn.loc,
            fix: `use one of: ${fn.params.map((p) => `param("${p.name}")`).join(", ") || "(the function has no parameters)"}`,
          });
        }
      }
      if (METHOD_DECORATORS.has(d.name) || modifiers.has(d.name) || fromPlugins.has(d.name)) continue;
      report(d.name, `function "${fn.name}"`, fn.loc, `if it is a modifier, declare it: \`@modifier ${d.name}(): void { require(…); }\``);
    }
  }
  for (const v of contract.stateVars) {
    for (const d of v.decorators) {
      if (FIELD_DECORATORS.has(d.name) || fromPlugins.has(d.name)) continue;
      report(d.name, `state variable "${v.name}"`, v.loc, "a state variable takes @storage and a visibility (@public_, @internal, @private_) only");
    }
  }
  return out;
}

export function validateContract(contract: IRContract, opts: ValidateOptions = {}, program?: IRProgram): Diagnostic[] {
  const out: Diagnostic[] = [];
  const resolution = resolveContract(contract);

  for (const fn of contract.functions) {
    for (const rule of RULES) {
      const found = rule(contract, fn, program);
      for (const d of found) {
        if (functionHasAllowFor(fn, d.rule)) continue;
        out.push(d);
      }
    }
  }

  for (const fn of contract.functions) {
    const res = resolution.functions.get(fn);
    if (!res) continue;
    if (res.stateMutability === "payable" && res.visibility && res.visibility !== "external" && res.visibility !== "public") {
      out.push({
        rule: "payable-visibility",
        severity: "error",
        message: `@payable function "${fn.name}" must be external or public`,
        loc: fn.loc,
        fix: "remove a non-public/external visibility decorator",
      });
    }
  }

  out.push(...ruleReservedIdentifiers(contract));
  out.push(...ruleEventDeclarations(contract, program));
  out.push(...ruleUndeclaredError(contract, program));

  for (const plugin of getPluginValidatorRules()) {
    for (const d of plugin.run(contract)) {
      out.push({ ...d, rule: `plugin:${plugin.name}/${d.rule}` });
    }
  }

  return out;
}

function reservedDiagnostic(name: string, subject: string, loc?: SourceLocation): Diagnostic {
  return {
    rule: "solidity-reserved-identifier",
    severity: "error",
    message: `${subject} is a reserved word in Solidity and cannot be used as an identifier`,
    loc,
    fix: `rename it (e.g. "${name}_" or a more specific name)`,
  };
}

/**
 * Solidity reserves names that are perfectly legal in TypeScript. Without this
 * check they reach solc, which reports the collision against generated .sol at
 * a line the developer never wrote.
 */
function ruleReservedIdentifiers(contract: IRContract): Diagnostic[] {
  const out: Diagnostic[] = [];

  if (isSolidityReserved(contract.name)) {
    out.push(reservedDiagnostic(contract.name, `contract "${contract.name}"`, contract.loc));
  }

  for (const v of contract.stateVars) {
    if (isSolidityReserved(v.name)) {
      out.push(reservedDiagnostic(v.name, `state variable "${v.name}"`, v.loc));
    }
  }

  for (const fn of contract.functions) {
    // `receive` and `fallback` are reserved precisely because they name these special functions.
    if (!fn.isConstructor && !(fn.special === "receive" || fn.special === "fallback") && isSolidityReserved(fn.name)) {
      out.push(reservedDiagnostic(fn.name, `function "${fn.name}"`, fn.loc));
    }
    // IRParam carries no loc, so these report against the function.
    for (const p of fn.params) {
      if (isSolidityReserved(p.name)) {
        out.push(reservedDiagnostic(p.name, `parameter "${p.name}" of function "${fn.name}"`, fn.loc));
      }
    }
    walkStatements(fn.body, (stmt) => {
      if (stmt.kind === "let" && isSolidityReserved(stmt.name)) {
        out.push(reservedDiagnostic(stmt.name, `local variable "${stmt.name}"`, stmt.loc ?? fn.loc));
      }
      if (stmt.kind === "destructure") {
        for (const n of stmt.names) {
          if (n && isSolidityReserved(n)) out.push(reservedDiagnostic(n, `local variable "${n}"`, stmt.loc ?? fn.loc));
        }
      }
    });
  }

  return out;
}

/**
 * Solidity allows at most 3 indexed parameters on a non-anonymous event, and
 * `emit` of a name that was never declared cannot compile. Both are caught here
 * so they report against the .ts source rather than generated Solidity.
 */
function ruleEventDeclarations(contract: IRContract, program?: IRProgram): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const ev of contract.events) {
    const indexed = ev.params.filter((p) => p.indexed);
    // An anonymous event spends no topic on its signature, so it has room for a fourth.
    const max = ev.anonymous ? 4 : 3;
    if (indexed.length > max) {
      out.push({
        rule: "event-too-many-indexed",
        severity: "error",
        message: `event "${ev.name}" has ${indexed.length} indexed parameters; Solidity allows at most ${max}${ev.anonymous ? " on an anonymous event" : ""}`,
        loc: ev.loc,
        fix: `drop Indexed<> from ${indexed.slice(max).map((p) => `"${p.name}"`).join(", ")}`,
      });
    }
  }

  // A base's events are the derived contract's too.
  const declared = new Set([contract, ...ancestorsOf(contract, program)].flatMap((c) => c.events.map((e) => e.name)));
  for (const fn of contract.functions) {
    walkStatements(fn.body, (stmt) => {
      if (stmt.kind === "emit" && !declared.has(stmt.eventName)) {
        out.push({
          rule: "undeclared-event",
          severity: "error",
          message: `"${stmt.eventName}" is emitted but never declared`,
          loc: stmt.loc ?? fn.loc,
          fix: `declare it: @event ${stmt.eventName}(...): void {}`,
        });
      }
    });
  }

  return out;
}

/**
 * `revert(MyError(...))` of a name that was never declared cannot compile.
 * Errors synthesized by the custom-errors optimizer pass are not visible here,
 * but those are generated from requires and always declared alongside.
 */
function ruleUndeclaredError(contract: IRContract, program?: IRProgram): Diagnostic[] {
  const out: Diagnostic[] = [];
  const declared = new Set([contract, ...ancestorsOf(contract, program)].flatMap((c) => c.errors.map((e) => e.name)));

  for (const fn of contract.functions) {
    walkStatements(fn.body, (stmt) => {
      if (stmt.kind === "revert" && stmt.errorName && !declared.has(stmt.errorName)) {
        out.push({
          rule: "undeclared-error",
          severity: "error",
          message: `"${stmt.errorName}" is reverted but never declared`,
          loc: stmt.loc ?? fn.loc,
          fix: `declare it: @error ${stmt.errorName}(...): void {}`,
        });
      }
    });
  }

  return out;
}

const RULES: Rule[] = [
  ruleViewDoesNotMutate,
  ruleNoTxOrigin,
  ruleUnboundedLoop,
  ruleNoIntegerDivisionWithoutComment,
  ruleNoBlockTimestampRandomness,
  ruleNoUncheckedLowLevelCall,
  ruleNoTransferInLoop,
  ruleStateMutationWithoutEvent,
  ruleNoMsgValueInNonPayable,
  ruleNoSelfdestruct,
  ruleNoDelegatecallToInput,
  ruleNoArbitraryCallTarget,
  ruleNoZeroAddressMint,
  ruleRequireCheckedAddress,
  ruleNoShadowedState,
  ruleConstructorIsConstructor,
  ruleNullishFallback,
  ruleDestructureShape,
  ruleStorageAlias,
  ruleValueTypeUnwrap,
];

/**
 * `unwrap(p)` is `Price.unwrap(p)`, with `Price` read off the type of `p`.
 * When that type is not known here -- `p` comes from somewhere inference
 * cannot follow -- the call would reach solc as an undeclared `unwrap`.
 */
function ruleValueTypeUnwrap(contract: IRContract, fn: IRFunction, program?: IRProgram): Diagnostic[] {
  const out: Diagnostic[] = [];
  walkScoped(fn.body, typeEnvFor(contract, fn, program), (stmt, scope) => {
    walkExpressionsInStatement(stmt, (e) => {
      if (e.kind !== "call" || e.callee.kind !== "identifier" || e.callee.name !== "unwrap" || e.args.length !== 1) return;
      const t = inferType(e.args[0]!, scope);
      if (t?.kind === "custom" && scope.valueTypes?.has(t.name)) return;
      out.push({
        rule: "value-type-unwrap",
        severity: "error",
        message: `\`unwrap(…)\` in "${fn.name}": ${t ? "the value is not a user-defined value type" : "the value's type is not known"}, so there is no \`T.unwrap\` to emit`,
        loc: stmt.loc ?? fn.loc,
        fix: "name the value type: `unwrap<Price>(p)`",
      });
    });
  });
  return out;
}

/**
 * `a ?? b` has no Solidity counterpart: a missing mapping key reads as the
 * type's default, never as undefined. `?? 0n` (or false / "" / address(0)) is
 * therefore a no-op and lowers to `a`. Any other fallback is lowered to an
 * explicit emptiness test when the type of `a` is known and testable; when it
 * is not, the fallback would be dropped, so that is an error. The test reads
 * `a` twice, so an `a` with side effects (a call, `++`) is an error as well:
 * `this.queue.get(this.pop()) ?? 1n` would pop twice.
 */
function ruleNullishFallback(contract: IRContract, fn: IRFunction): Diagnostic[] {
  const out: Diagnostic[] = [];
  walkScoped(fn.body, typeEnvFor(contract, fn), (stmt, scope) => {
    walkExpressionsInStatement(stmt, (e) => {
      if (e.kind !== "nullish" || isZeroLiteral(e.right)) return;
      const type = inferType(e.left, scope);
      const test = emptinessTest(type);
      if (test && hasSideEffects(e.left)) {
        out.push({
          rule: "nullish-fallback",
          severity: "error",
          message: `\`?? fallback\` in "${fn.name}" cannot be lowered: the left side has side effects (a call or an update) and the lowering evaluates it twice`,
          loc: stmt.loc ?? fn.loc,
          fix: "bind the left side to a typed local first (`const v: bigint = …; return v ?? 1n;`), or write the test explicitly with an if / ternary",
        });
      } else if (test) {
        out.push({
          rule: "nullish-fallback",
          severity: "info",
          message: `\`?? fallback\` in "${fn.name}" lowers to an explicit default-value test (${test.replace("$", "a")} ? fallback : a); the left side is evaluated twice`,
          loc: stmt.loc ?? fn.loc,
        });
      } else {
        out.push({
          rule: "nullish-fallback",
          severity: "error",
          message: `\`?? fallback\` in "${fn.name}" cannot be lowered: the left side's type is ${type ? "not testable for emptiness" : "unknown"}, so the fallback would be silently dropped`,
          loc: stmt.loc ?? fn.loc,
          fix: "drop the fallback (a mapping read already yields the type's default), or write the test explicitly with an if / ternary",
        });
      }
    });
  });
  return out;
}

/**
 * `const p = cond ? this.items[i] : other` -- a struct, array or mapping from a
 * ternary with one storage branch and one memory branch. Solidity has no data
 * location that fits both: `storage` cannot hold the memory side and `memory`
 * would copy the storage side, so a write through `p` would be lost whenever
 * the storage branch was taken. The emitter leaves such a local untyped
 * rather than guess, and this rule is what says so.
 */
function ruleStorageAlias(contract: IRContract, fn: IRFunction): Diagnostic[] {
  const out: Diagnostic[] = [];
  walkScoped(fn.body, typeEnvFor(contract, fn), (stmt, scope) => {
    if (stmt.kind !== "let" || !stmt.init || !mixesStorageAndMemory(stmt.init, scope)) return;
    out.push({
      rule: "storage-alias",
      severity: "error",
      message: `"${stmt.name}" in "${fn.name}" binds a ternary with one storage branch and one memory branch; no data location fits both, so writes through it would be lost`,
      loc: stmt.loc ?? fn.loc,
      fix: "bind each branch in its own if / else block, or, if it is only read, copy the storage side first (`const s: T = this.items[i]; const p = cond ? s : other`)",
    });
  });
  return out;
}

/**
 * `const [a, b] = expr` needs component types. They are known for low-level
 * calls (`(bool, bytes memory)`) and for a tuple annotation; anything else
 * cannot be emitted correctly.
 */
function ruleDestructureShape(contract: IRContract, fn: IRFunction, program?: IRProgram): Diagnostic[] {
  const out: Diagnostic[] = [];
  walkScoped(fn.body, typeEnvFor(contract, fn, program), (stmt, scope) => {
    if (stmt.kind !== "destructure") return;
    if (isLowLevelCall(stmt.init)) {
      if (stmt.names.length > 2) {
        out.push({
          rule: "destructure-shape",
          severity: "error",
          message: `low-level call in "${fn.name}" returns (bool, bytes) but ${stmt.names.length} names are destructured`,
          loc: stmt.loc ?? fn.loc,
        });
      }
      return;
    }
    if (destructureShapeKnown(stmt, scope)) return;
    out.push({
      rule: "destructure-shape",
      severity: "error",
      message: `destructuring in "${fn.name}" needs a tuple type annotation so the component types can be emitted`,
      loc: stmt.loc ?? fn.loc,
      fix: `const [${stmt.names.map((n) => n ?? "").join(", ")}]: [bigint, boolean] = …`,
    });
  });
  return out;
}

/**
 * `CheckedAddress` is a TypeScript brand that is erased at emit; the only thing
 * that makes it real is `validate()`, which lowers to a runtime
 * `require(a != address(0))`. This rule closes the gap the brand leaves open:
 * an `Address` parameter (or a local aliasing one) that reaches a
 * `.transfer` / `.send` / `.call` / `.delegatecall` / `.staticcall` target or
 * `pullPayment()` without going through `validate()` first.
 *
 * Considered checked: `CheckedAddress`-typed params, locals initialised from
 * `validate(...)`, and `msg.sender` (typed `CheckedAddress`).
 */
function ruleRequireCheckedAddress(_contract: IRContract, fn: IRFunction): Diagnostic[] {
  const out: Diagnostic[] = [];
  const unchecked = new Set<string>();
  for (const p of fn.params) {
    if (p.type.kind === "primitive" && p.type.name === "address") unchecked.add(p.name);
  }
  if (unchecked.size === 0) return out;

  const checked = new Set<string>();
  for (const p of fn.params) if (p.type.kind === "custom" && p.type.name === "CheckedAddress") checked.add(p.name);

  const isValidateCall = (e: IRExpression): boolean =>
    e.kind === "call" && e.callee.kind === "identifier" && e.callee.name === "validate";

  // Locals: `const v = validate(to)` is checked; `const alias = to` inherits to's status.
  walkStatements(fn.body, (stmt) => {
    if (stmt.kind !== "let" || !stmt.init) return;
    const init = stmt.init.kind === "paren" ? stmt.init.inner : stmt.init;
    if (isValidateCall(init) || (stmt.type?.kind === "custom" && stmt.type.name === "CheckedAddress")) {
      checked.add(stmt.name);
      unchecked.delete(stmt.name);
    } else if (init.kind === "identifier" && unchecked.has(init.name)) {
      unchecked.add(stmt.name);
    }
  });

  /** The address expression a value-moving call targets, with `payable(x)` peeled off. */
  const targetOf = (e: IRExpression): IRExpression | undefined => {
    if (e.kind !== "call") return undefined;
    if (e.callee.kind === "identifier" && e.callee.name === "pullPayment" && e.args.length >= 1) return e.args[0];
    if (e.callee.kind !== "member") return undefined;
    if (!["transfer", "send", "call", "delegatecall", "staticcall"].includes(e.callee.property)) return undefined;
    let obj = e.callee.object;
    while (obj.kind === "paren") obj = obj.inner;
    if (obj.kind === "call" && obj.callee.kind === "identifier" && obj.callee.name === "payable" && obj.args.length === 1) {
      obj = obj.args[0]!;
    }
    return obj;
  };

  const reported = new Set<string>();
  walkStatements(fn.body, (stmt) => {
    walkExpressionsInStatement(stmt, (e) => {
      const target = targetOf(e);
      if (!target) return;
      if (isValidateCall(target)) return;
      const inner = target.kind === "paren" ? target.inner : target;
      if (inner.kind !== "identifier" || !unchecked.has(inner.name) || checked.has(inner.name)) return;
      const via = e.kind === "call" && e.callee.kind === "member" ? `.${e.callee.property}()` : "pullPayment()";
      const key = `${inner.name}:${via}`;
      if (reported.has(key)) return;
      reported.add(key);
      out.push({
        rule: "require-checked-address",
        severity: "warning",
        message: `address "${inner.name}" reaches ${via} in "${fn.name}" without validate() — a zero or unchecked address can burn funds`,
        loc: stmt.loc ?? fn.loc,
        fix: `const checked = validate(${inner.name}); …${via === "pullPayment()" ? "pullPayment(checked, …)" : `payable(checked)${via}`}, or type the parameter CheckedAddress`,
      });
    });
  });
  return out;
}

function ruleViewDoesNotMutate(contract: IRContract, fn: IRFunction): Diagnostic[] {
  if (!fn.decorators.some((d) => d.name === "view" || d.name === "pure")) return [];
  const isPure = fn.decorators.some((d) => d.name === "pure");
  const stateNames = new Set(contract.stateVars.map((v) => v.name));
  const out: Diagnostic[] = [];
  walkStatements(fn.body, (stmt) => {
    if (stmt.kind === "expression" && stmt.expr.kind === "assign") {
      if (touchesState(stmt.expr.left, stateNames)) {
        out.push({
          rule: isPure ? "pure-no-mutate" : "view-no-mutate",
          severity: "error",
          message: `@${isPure ? "pure" : "view"} function "${fn.name}" mutates state`,
          loc: stmt.loc,
        });
      }
    }
    if (stmt.kind === "expression" && stmt.expr.kind === "unary" && stmt.expr.op === "delete") {
      if (touchesState(stmt.expr.operand, stateNames)) {
        out.push({
          rule: isPure ? "pure-no-mutate" : "view-no-mutate",
          severity: "error",
          message: `@${isPure ? "pure" : "view"} function "${fn.name}" mutates state via delete`,
          loc: stmt.loc,
        });
      }
    }
    if (stmt.kind === "expression" && stmt.expr.kind === "call" && stmt.expr.callee.kind === "member") {
      const m = stmt.expr.callee;
      if (m.property === "set" || m.property === "delete") {
        if (touchesState(m.object, stateNames)) {
          out.push({
            rule: isPure ? "pure-no-mutate" : "view-no-mutate",
            severity: "error",
            message: `@${isPure ? "pure" : "view"} function "${fn.name}" mutates state via .${m.property}()`,
            loc: stmt.loc,
          });
        }
      }
    }
  });
  return out;
}

function touchesState(expr: IRExpression, stateNames: Set<string>): boolean {
  if (expr.kind === "member" && expr.object.kind === "this") return stateNames.has(expr.property);
  if (expr.kind === "index") return touchesState(expr.object, stateNames);
  if (expr.kind === "identifier") return stateNames.has(expr.name);
  return false;
}

function ruleNoTxOrigin(_contract: IRContract, fn: IRFunction): Diagnostic[] {
  const out: Diagnostic[] = [];
  walkStatements(fn.body, (stmt) => {
    walkExpressionsInStatement(stmt, (expr) => {
      if (expr.kind === "member" && expr.object.kind === "identifier" && expr.object.name === "tx" && expr.property === "origin") {
        out.push({
          rule: "no-tx-origin",
          severity: "warning",
          message: `tx.origin used in "${fn.name}" — use msg.sender instead`,
          loc: stmt.loc,
          fix: "replace tx.origin with msg.sender for authentication",
        });
      }
    });
  });
  return out;
}

function ruleUnboundedLoop(_contract: IRContract, fn: IRFunction): Diagnostic[] {
  const out: Diagnostic[] = [];
  walkStatements(fn.body, (stmt) => {
    if (stmt.kind === "while") {
      out.push({
        rule: "unbounded-loop",
        severity: "warning",
        message: `while-loop in "${fn.name}" may be unbounded; consider a hard cap to bound gas`,
        loc: stmt.loc,
      });
    }
  });
  return out;
}

function ruleNoIntegerDivisionWithoutComment(_contract: IRContract, fn: IRFunction): Diagnostic[] {
  const out: Diagnostic[] = [];
  walkStatements(fn.body, (stmt) => {
    walkExpressionsInStatement(stmt, (expr) => {
      if (expr.kind === "binary" && expr.op === "/") {
        out.push({
          rule: "integer-division",
          severity: "info",
          message: `integer division truncates toward zero — verify rounding behavior in "${fn.name}"`,
          loc: stmt.loc,
        });
      }
    });
  });
  return out;
}

function ruleConstructorIsConstructor(_contract: IRContract, fn: IRFunction): Diagnostic[] {
  if (fn.isConstructor && fn.decorators.length > 0) {
    return [{
      rule: "constructor-no-decorators",
      severity: "error",
      message: `constructor cannot carry decorators`,
      loc: fn.loc,
    }];
  }
  return [];
}

function ruleNoBlockTimestampRandomness(_contract: IRContract, fn: IRFunction): Diagnostic[] {
  const out: Diagnostic[] = [];
  walkStatements(fn.body, (stmt) => {
    walkExpressionsInStatement(stmt, (expr) => {
      if (expr.kind === "call" && expr.callee.kind === "identifier" &&
          (expr.callee.name === "keccak256" || expr.callee.name === "sha256")) {
        for (const a of expr.args) {
          let usesTimestamp = false;
          walkExpr(a, (e) => {
            if (e.kind === "member" && e.object.kind === "identifier" &&
                e.object.name === "block" && e.property === "timestamp") usesTimestamp = true;
          });
          if (usesTimestamp) {
            out.push({
              rule: "no-block-timestamp-randomness",
              severity: "error",
              message: `block.timestamp used as randomness source in "${fn.name}" — miners can manipulate`,
              loc: stmt.loc,
              fix: "use Chainlink VRF or a commit-reveal scheme",
            });
          }
        }
      }
    });
  });
  return out;
}

function ruleNoUncheckedLowLevelCall(_contract: IRContract, fn: IRFunction): Diagnostic[] {
  const out: Diagnostic[] = [];
  walkStatements(fn.body, (stmt) => {
    if (stmt.kind !== "expression") return;
    const e = stmt.expr;
    if (e.kind === "call" && e.callee.kind === "member" &&
        (e.callee.property === "call" || e.callee.property === "delegatecall" || e.callee.property === "send")) {
      out.push({
        rule: "no-unchecked-low-level-call",
        severity: "warning",
        message: `low-level .${e.callee.property}() result not checked in "${fn.name}"`,
        loc: stmt.loc,
        fix: "use `const [ok,] = … ; require(ok, \"call failed\")`",
      });
    }
  });
  return out;
}

function ruleNoTransferInLoop(_contract: IRContract, fn: IRFunction): Diagnostic[] {
  const out: Diagnostic[] = [];
  walkStatements(fn.body, (stmt) => {
    if (stmt.kind !== "for" && stmt.kind !== "while") return;
    walkStatements(stmt.body, (inner) => {
      walkExpressionsInStatement(inner, (e) => {
        if (e.kind === "call" && e.callee.kind === "member" &&
            (e.callee.property === "transfer" || e.callee.property === "send")) {
          out.push({
            rule: "no-transfer-in-loop",
            severity: "warning",
            message: `${e.callee.property}() inside loop in "${fn.name}" — a single failed transfer reverts all`,
            loc: inner.loc,
            fix: "use pull-payment pattern; let recipients withdraw separately",
          });
        }
      });
    });
  });
  return out;
}

function ruleStateMutationWithoutEvent(contract: IRContract, fn: IRFunction): Diagnostic[] {
  if (fn.isConstructor || fn.isAssembly) return [];
  if (fn.decorators.some((d) => d.name === "view" || d.name === "pure")) return [];
  if (contract.events.length === 0) return [];

  let mutates = false;
  let emits = false;
  walkStatements(fn.body, (stmt) => {
    // `emit(...)` is parsed into a dedicated emit statement, not a call.
    if (stmt.kind === "emit") emits = true;
    if (stmt.kind === "expression") {
      if (stmt.expr.kind === "assign" && stmt.expr.left.kind === "member" &&
          stmt.expr.left.object.kind === "this") mutates = true;
    }
  });

  if (mutates && !emits) {
    return [{
      rule: "state-mutation-without-event",
      severity: "info",
      message: `"${fn.name}" mutates state but emits no event`,
      loc: fn.loc,
      fix: "emit an event so off-chain indexers can track the change",
    }];
  }
  return [];
}

function ruleNoMsgValueInNonPayable(_contract: IRContract, fn: IRFunction): Diagnostic[] {
  if (fn.decorators.some((d) => d.name === "payable") || fn.payable) return [];
  const out: Diagnostic[] = [];
  walkStatements(fn.body, (stmt) => {
    walkExpressionsInStatement(stmt, (e) => {
      if (e.kind === "member" && e.object.kind === "identifier" &&
          e.object.name === "msg" && e.property === "value") {
        out.push({
          rule: "no-msg-value-in-non-payable",
          severity: "warning",
          message: `msg.value referenced in non-payable "${fn.name}" — will always be zero`,
          loc: stmt.loc,
          fix: "add @payable to the function, or remove the msg.value read",
        });
      }
    });
  });
  return out;
}

function ruleNoSelfdestruct(_contract: IRContract, fn: IRFunction): Diagnostic[] {
  const out: Diagnostic[] = [];
  walkStatements(fn.body, (stmt) => {
    walkExpressionsInStatement(stmt, (e) => {
      if (e.kind === "call" && e.callee.kind === "identifier" &&
          (e.callee.name === "selfdestruct" || e.callee.name === "suicide")) {
        out.push({
          rule: "no-selfdestruct",
          severity: "error",
          message: `selfdestruct used in "${fn.name}" — opcode is being removed (EIP-6049)`,
          loc: stmt.loc,
        });
      }
    });
  });
  return out;
}

function ruleNoDelegatecallToInput(_contract: IRContract, fn: IRFunction): Diagnostic[] {
  const paramNames = new Set(fn.params.map((p) => p.name));
  const out: Diagnostic[] = [];
  walkStatements(fn.body, (stmt) => {
    walkExpressionsInStatement(stmt, (e) => {
      if (e.kind === "call" && e.callee.kind === "member" && e.callee.property === "delegatecall") {
        if (e.callee.object.kind === "identifier" && paramNames.has(e.callee.object.name)) {
          out.push({
            rule: "no-delegatecall-to-input",
            severity: "error",
            message: `delegatecall to function input "${e.callee.object.name}" in "${fn.name}" — attacker-controlled code execution`,
            loc: stmt.loc,
          });
        }
      }
    });
  });
  return out;
}

function ruleNoArbitraryCallTarget(_contract: IRContract, fn: IRFunction): Diagnostic[] {
  const paramNames = new Set(fn.params.map((p) => p.name));
  const out: Diagnostic[] = [];
  walkStatements(fn.body, (stmt) => {
    walkExpressionsInStatement(stmt, (e) => {
      if (e.kind === "call" && e.callee.kind === "member" && e.callee.property === "call") {
        if (e.callee.object.kind === "identifier" && paramNames.has(e.callee.object.name)) {
          out.push({
            rule: "no-arbitrary-call-target",
            severity: "warning",
            message: `low-level .call to function input "${e.callee.object.name}" in "${fn.name}"`,
            loc: stmt.loc,
            fix: "validate target against an allowlist before calling",
          });
        }
      }
    });
  });
  return out;
}

function ruleNoZeroAddressMint(_contract: IRContract, fn: IRFunction): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!/mint|transfer/i.test(fn.name)) return out;
  let hasZeroCheck = false;
  walkStatements(fn.body, (stmt) => {
    walkExpressionsInStatement(stmt, (e) => {
      if (e.kind === "binary" && (e.op === "==" || e.op === "!=" || e.op === "===" || e.op === "!==")) {
        const looksLikeZeroAddr = (x: IRExpression) =>
          (x.kind === "call" && x.callee.kind === "identifier" && x.callee.name === "address" &&
            x.args.length === 1 && x.args[0]!.kind === "literal" && x.args[0]!.value === "0");
        if (looksLikeZeroAddr(e.left) || looksLikeZeroAddr(e.right)) hasZeroCheck = true;
      }
    });
  });
  const recipientParam = fn.params.find((p) => p.type.kind === "primitive" && p.type.name === "address");
  if (recipientParam && !hasZeroCheck) {
    out.push({
      rule: "no-zero-address-mint",
      severity: "info",
      message: `"${fn.name}" accepts an address but does not check it against address(0)`,
      loc: fn.loc,
      fix: `add: require(${recipientParam.name} != address(0), "zero address")`,
    });
  }
  return out;
}

function ruleNoShadowedState(contract: IRContract, fn: IRFunction): Diagnostic[] {
  const stateNames = new Set(contract.stateVars.map((v) => v.name));
  const out: Diagnostic[] = [];
  walkStatements(fn.body, (stmt) => {
    const locals = stmt.kind === "let" ? [stmt.name] : stmt.kind === "destructure" ? stmt.names.filter((n): n is string => !!n) : [];
    for (const name of locals) {
      if (!stateNames.has(name)) continue;
      out.push({
        rule: "no-shadowed-state",
        severity: "warning",
        message: `local "${name}" in "${fn.name}" shadows state variable`,
        loc: stmt.loc,
      });
    }
  });
  for (const p of fn.params) {
    if (stateNames.has(p.name)) {
      out.push({
        rule: "no-shadowed-state",
        severity: "warning",
        message: `parameter "${p.name}" in "${fn.name}" shadows state variable`,
        loc: fn.loc,
      });
    }
  }
  return out;
}

function mutatesState(expr: IRExpression): boolean {
  if (expr.kind === "member" && expr.object.kind === "this") return true;
  if (expr.kind === "index") return mutatesState(expr.object);
  if (expr.kind === "identifier") return true;
  return false;
}



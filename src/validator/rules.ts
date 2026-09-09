import type {
  IRContract,
  IRExpression,
  IRFunction,
  IRProgram,
  IRStatement,
  SourceLocation,
} from "../ir/types";
import { resolveContract } from "../mapper/decorators";
import type { Diagnostic } from "./diagnostics";
import { getPluginValidatorRules } from "../plugin/api";
import { isSolidityReserved } from "./reserved";

type Rule = (contract: IRContract, fn: IRFunction) => Diagnostic[];

export interface ValidateOptions {
  secure?: boolean;
}

export function validateProgram(program: IRProgram, opts: ValidateOptions = {}): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const contract of program.contracts) {
    out.push(...validateContract(contract, opts));
  }
  if (opts.secure) {
    return out.map((d) => applySecureEscalation(d));
  }
  return out;
}

const SECURE_ESCALATE_RULES = new Set([
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

export function validateContract(contract: IRContract, opts: ValidateOptions = {}): Diagnostic[] {
  const out: Diagnostic[] = [];
  const resolution = resolveContract(contract);

  for (const fn of contract.functions) {
    for (const rule of RULES) {
      const found = rule(contract, fn);
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
    if (!fn.isConstructor && isSolidityReserved(fn.name)) {
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
  ruleNoShadowedState,
  ruleConstructorIsConstructor,
];

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
    if (stmt.kind === "expression") {
      if (stmt.expr.kind === "assign" && stmt.expr.left.kind === "member" &&
          stmt.expr.left.object.kind === "this") mutates = true;
      if (stmt.expr.kind === "call" && stmt.expr.callee.kind === "identifier" &&
          stmt.expr.callee.name === "emit") emits = true;
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
  if (fn.decorators.some((d) => d.name === "payable")) return [];
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
    if (stmt.kind === "let" && stateNames.has(stmt.name)) {
      out.push({
        rule: "no-shadowed-state",
        severity: "warning",
        message: `local "${stmt.name}" in "${fn.name}" shadows state variable`,
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

function walkStatements(stmts: IRStatement[], visit: (s: IRStatement) => void): void {
  for (const s of stmts) {
    visit(s);
    if (s.kind === "if") {
      walkStatements(s.then, visit);
      if (s.else) walkStatements(s.else, visit);
    }
    if (s.kind === "for" || s.kind === "while" || s.kind === "block") {
      walkStatements(s.body, visit);
    }
  }
}

function walkExpressionsInStatement(stmt: IRStatement, visit: (e: IRExpression) => void): void {
  if (stmt.kind === "expression") walkExpr(stmt.expr, visit);
  if (stmt.kind === "return" && stmt.value) walkExpr(stmt.value, visit);
  if (stmt.kind === "if") walkExpr(stmt.test, visit);
  if (stmt.kind === "while") walkExpr(stmt.test, visit);
  if (stmt.kind === "for") {
    if (stmt.test) walkExpr(stmt.test, visit);
    if (stmt.update) walkExpr(stmt.update, visit);
  }
  if (stmt.kind === "let" && stmt.init) walkExpr(stmt.init, visit);
}

function walkExpr(expr: IRExpression, visit: (e: IRExpression) => void): void {
  visit(expr);
  switch (expr.kind) {
    case "member": return walkExpr(expr.object, visit);
    case "index": walkExpr(expr.object, visit); walkExpr(expr.index, visit); return;
    case "call": walkExpr(expr.callee, visit); for (const a of expr.args) walkExpr(a, visit); return;
    case "new": for (const a of expr.args) walkExpr(a, visit); return;
    case "binary": walkExpr(expr.left, visit); walkExpr(expr.right, visit); return;
    case "unary": walkExpr(expr.operand, visit); return;
    case "conditional": walkExpr(expr.test, visit); walkExpr(expr.consequent, visit); walkExpr(expr.alternate, visit); return;
    case "nullish": walkExpr(expr.left, visit); walkExpr(expr.right, visit); return;
    case "assign": walkExpr(expr.left, visit); walkExpr(expr.right, visit); return;
    case "paren": walkExpr(expr.inner, visit); return;
    case "templateString": for (const e of expr.expressions) walkExpr(e, visit); return;
  }
}

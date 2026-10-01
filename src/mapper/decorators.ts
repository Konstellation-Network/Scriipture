import type { IRContract, IRDecorator, IRFunction } from "../ir/types";

export interface DecoratorResolution {
  modifiers: string[];
  imports: string[];
  inheritedContracts: string[];
  stateMutability?: "view" | "pure" | "payable" | "nonpayable";
  isStorage: boolean;
  isEscapeHatch: boolean;
  visibility?: "public" | "external" | "internal" | "private";
}

interface DecoratorRule {
  modifier?: string;
  import?: string;
  inherits?: string;
  stateMutability?: "view" | "pure" | "payable";
  visibility?: "public" | "external" | "internal" | "private";
}

export const FUNCTION_DECORATORS: Record<string, DecoratorRule> = {
  view: { stateMutability: "view" },
  pure: { stateMutability: "pure" },
  invariant: { stateMutability: "view" },
  payable: { stateMutability: "payable" },
  onlyOwner: {
    modifier: "onlyOwner",
    import: "@openzeppelin/contracts/access/Ownable.sol",
    inherits: "Ownable",
  },
  nonReentrant: {
    modifier: "nonReentrant",
    import: "@openzeppelin/contracts/utils/ReentrancyGuard.sol",
    inherits: "ReentrancyGuard",
  },
  whenNotPaused: {
    modifier: "whenNotPaused",
    import: "@openzeppelin/contracts/utils/Pausable.sol",
    inherits: "Pausable",
  },
  external: { visibility: "external" },
  public: { visibility: "public" },
  internal: { visibility: "internal" },
  private: { visibility: "private" },
};

export const SAFETY_OVERRIDE_DECORATORS = new Set([
  "unsafe",
  "allowTxOrigin",
  "allowSelfdestruct",
  "allowZeroAddress",
  "allowLowLevelCall",
]);

export function resolveFunctionDecorators(decorators: IRDecorator[]): DecoratorResolution {
  const out: DecoratorResolution = {
    modifiers: [],
    imports: [],
    inheritedContracts: [],
    isStorage: false,
    isEscapeHatch: false,
  };

  for (const d of decorators) {
    if (d.name === "storage") {
      out.isStorage = true;
      continue;
    }
    if (d.name === "solidity" || d.name === "assembly") {
      out.isEscapeHatch = true;
      continue;
    }
    const rule = FUNCTION_DECORATORS[d.name];
    if (!rule) continue;
    if (rule.modifier) out.modifiers.push(rule.modifier);
    if (rule.import) out.imports.push(rule.import);
    if (rule.inherits) out.inheritedContracts.push(rule.inherits);
    if (rule.stateMutability) out.stateMutability = rule.stateMutability;
    if (rule.visibility) out.visibility = rule.visibility;
  }

  return out;
}

const STANDARD_IMPORTS: Record<string, string> = {
  ERC20: "@openzeppelin/contracts/token/ERC20/ERC20.sol",
  ERC721: "@openzeppelin/contracts/token/ERC721/ERC721.sol",
  Ownable: "@openzeppelin/contracts/access/Ownable.sol",
  ReentrancyGuard: "@openzeppelin/contracts/utils/ReentrancyGuard.sol",
  Test: "forge-std/Test.sol",
};

/** The import path for a base contract Scriipture bundles, or undefined for a user-defined one. */
export function standardImportFor(base: string): string | undefined {
  return STANDARD_IMPORTS[base];
}

export interface ContractResolution {
  imports: Set<string>;
  inheritedContracts: string[];
  functions: Map<IRFunction, DecoratorResolution>;
}

export function resolveContract(contract: IRContract): ContractResolution {
  const imports = new Set<string>();
  const inheritedContracts: string[] = [];
  const seenInherited = new Set<string>();

  for (const base of contract.bases) {
    if (!seenInherited.has(base)) {
      inheritedContracts.push(base);
      seenInherited.add(base);
    }
    const imp = STANDARD_IMPORTS[base];
    if (imp) imports.add(imp);
  }

  const functions = new Map<IRFunction, DecoratorResolution>();
  for (const fn of contract.functions) {
    const res = resolveFunctionDecorators(fn.decorators);
    for (const imp of res.imports) imports.add(imp);
    for (const inh of res.inheritedContracts) {
      if (!seenInherited.has(inh)) {
        inheritedContracts.push(inh);
        seenInherited.add(inh);
        const stdImp = STANDARD_IMPORTS[inh];
        if (stdImp) imports.add(stdImp);
      }
    }
    functions.set(fn, res);
  }

  return { imports, inheritedContracts, functions };
}

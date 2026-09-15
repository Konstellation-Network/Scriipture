/**
 * Scriipture — write smart contracts in TypeScript, ship Solidity.
 *
 * This is the library entry point. CLI users invoke via `scriipture` binary;
 * library users import from this module.
 */

export { parseContractFiles } from "./parser/parse";
export type { ParseDiagnostic, ParseResult } from "./parser/parse";

export { emitProgram, emitContract } from "./emitter/emit";
export type { EmitOptions, EmittedContract } from "./emitter/emit";

export { validateProgram, validateContract } from "./validator/rules";
export type { ValidateOptions } from "./validator/rules";
export type { Diagnostic, Severity } from "./validator/diagnostics";
export { formatDiagnostic } from "./validator/diagnostics";

export { optimizeProgram, optimizeContract, PASSES as OPTIMIZER_PASSES } from "./optimizer/passes";
export type { OptimizationReport, OptimizationChange, OptimizeOptions, Pass } from "./optimizer/passes";
export { computePackedLayout, countStorageSlots, storageBitSize } from "./optimizer/pack-slots";
export type { PackedLayout } from "./optimizer/pack-slots";

export { compileSolidity } from "./compiler/solc";
export type { CompileInput, CompileResult, CompiledArtifact, SMTCheckerFinding } from "./compiler/solc";

export { buildSourceMap } from "./sourcemaps/emit";
export type { SourceMap, SourceMapEntry } from "./sourcemaps/emit";

export { resolveContract } from "./mapper/decorators";
export type { ContractResolution, DecoratorResolution } from "./mapper/decorators";

export { ConfigSchema, NetworkConfigSchema, CompilerConfigSchema } from "./config/schema";
export type { Config, NetworkConfig } from "./config/schema";
export { loadConfig } from "./config/load";

export type {
  IRContract,
  IRProgram,
  IRFunction,
  IRStateVar,
  IRType,
  IRExpression,
  IRStatement,
  IRDecorator,
  IRParam,
  IRErrorDecl,
  IREventDecl,
  IRStructDecl,
  IREnumDecl,
  IRPrimitiveName,
  IntBits,
  BytesN,
  SourceLocation,
} from "./ir/types";

export type { ScriipturePlugin, PluginOptimizerPass, PluginValidatorRule } from "./plugin/api";
export { setPluginRegistry, getPluginRegistry } from "./plugin/api";
export { loadPlugins } from "./plugin/loader";

export { runSlither, slitherInstalled } from "./audit/slither";
export type { SlitherFinding, SlitherResult } from "./audit/slither";

export { runMythril, mythrilInstalled } from "./audit/mythril";
export type { MythrilFinding, MythrilResult, MythrilOptions } from "./audit/mythril";

export { renderAuditNotes } from "./audit/notes";

export { generateFuzzHarness } from "./security/fuzz-gen";
export { collectInvariants, renderInvariantTest } from "./security/invariants";
export type { InvariantSpec } from "./security/invariants";
export { checkPatterns, hashBytecode } from "./security/pattern-library";
export {
  collectToolVersions,
  writeAttestation,
  attestationFingerprint,
  sha256,
  gatePassed,
  gateFailed,
  gateSkipped,
  gateNotApplicable,
  unjustifiedSkippedGates,
} from "./security/attestation";
export type { AttestationBundle, GateResult, GateStatus, ToolVersion } from "./security/attestation";

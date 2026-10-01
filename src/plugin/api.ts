import type { IRContract } from "../ir/types";
import type { OptimizationChange } from "../optimizer/passes";
import type { Diagnostic } from "../validator/diagnostics";

export type PluginOptimizerPass = {
  name: string;
  run: (contract: IRContract) => OptimizationChange[];
};

export type PluginValidatorRule = {
  name: string;
  run: (contract: IRContract) => Diagnostic[];
};

export interface ScriipturePlugin {
  name: string;
  optimizerPasses?: PluginOptimizerPass[];
  validatorRules?: PluginValidatorRule[];
  /**
   * Decorator names this plugin gives meaning to. Any other decorator
   * Scriipture does not know is an `unknown-decorator` error, since it would
   * otherwise vanish from the emitted Solidity.
   */
  decorators?: string[];
}

export interface PluginRegistry {
  plugins: ScriipturePlugin[];
}

let _registry: PluginRegistry = { plugins: [] };

export function setPluginRegistry(reg: PluginRegistry): void {
  _registry = reg;
}

export function getPluginRegistry(): PluginRegistry {
  return _registry;
}

export function getPluginOptimizerPasses(): PluginOptimizerPass[] {
  return _registry.plugins.flatMap((p) => p.optimizerPasses ?? []);
}

export function getPluginValidatorRules(): PluginValidatorRule[] {
  return _registry.plugins.flatMap((p) => p.validatorRules ?? []);
}

export function getPluginDecorators(): string[] {
  return _registry.plugins.flatMap((p) => p.decorators ?? []);
}

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export interface ToolVersion {
  name: string;
  version: string;
}

/**
 * What actually happened to a gate.
 *
 * - `passed` / `failed`: the gate ran and produced a verdict.
 * - `skipped`: the gate was switched off (`--skip`, `--no-*`, or an opt-in gate not enabled).
 * - `not-applicable`: the gate had nothing to check (no invariants declared, no fuzzable methods).
 *
 * An attestation must let a reader tell "clean" from "never ran", so `passed`
 * is only true when the status is `passed`.
 */
export type GateStatus = "passed" | "failed" | "skipped" | "not-applicable";

export interface GateResult {
  name: string;
  status: GateStatus;
  /** `true` only when `status === "passed"`. Kept for readers of schemaVersion 1. */
  passed: boolean;
  detail?: string;
  findings?: number;
  /** Set on skipped gates when the operator supplied a reason for shipping without them. */
  justification?: string;
  /** Gate is off unless explicitly enabled (Mythril `--deep`); skipping it needs no justification. */
  optIn?: boolean;
  /**
   * Which tool produced this verdict, e.g. "native-solc 0.8.37+commit.f401782d".
   * Two solc builds of the same version differ in whether a Horn solver is
   * compiled in, so the version alone does not say whether the check could run.
   */
  engine?: string;
}

export function gatePassed(name: string, detail?: string, findings?: number): GateResult {
  return { name, status: "passed", passed: true, detail, findings };
}

export function gateFailed(name: string, detail?: string, findings?: number): GateResult {
  return { name, status: "failed", passed: false, detail, findings };
}

export function gateSkipped(
  name: string,
  reason: string,
  extra: { justification?: string; optIn?: boolean } = {},
): GateResult {
  const r: GateResult = { name, status: "skipped", passed: false, detail: reason };
  if (extra.justification) r.justification = extra.justification;
  if (extra.optIn) r.optIn = true;
  return r;
}

export function gateNotApplicable(name: string, reason: string): GateResult {
  return { name, status: "not-applicable", passed: false, detail: reason };
}

/** Skipped gates that would leave a hole in the attestation: not opt-in and not justified. */
export function unjustifiedSkippedGates<T extends GateResult>(gates: T[]): T[] {
  return gates.filter((g) => g.status === "skipped" && !g.optIn && !g.justification);
}

export interface AttestationBundle {
  schemaVersion: 2;
  contract: string;
  network?: string;
  address?: string;
  hashes: {
    tsSource: string;
    solSource: string;
    bytecode?: string;
    deployedBytecode?: string;
  };
  tools: ToolVersion[];
  gates: GateResult[];
  optimizations: Array<{ pass: string; detail: string; applied?: boolean }>;
  diagnostics: Array<{ rule: string; severity: string; message: string }>;
  generatedAt: string;
  generatedBy: string;
}

export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function sha256File(p: string): string {
  return sha256(fs.readFileSync(p, "utf8"));
}

export function collectToolVersions(): ToolVersion[] {
  const versions: ToolVersion[] = [];
  versions.push({ name: "scriipture", version: readScriiptureVersion() });
  for (const tool of ["solc", "slither", "myth", "forge", "anvil", "bun", "node"] as const) {
    const v = probe(tool, "--version");
    if (v) versions.push({ name: tool, version: v });
  }
  return versions;
}

function probe(cmd: string, flag: string): string | null {
  const r = spawnSync(cmd, [flag], { encoding: "utf8", env: process.env });
  if (r.status !== 0) return null;
  return (r.stdout || r.stderr).split("\n")[0]?.trim() ?? null;
}

function readScriiptureVersion(): string {
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const candidates = [
      path.resolve(here, "..", "..", "package.json"),
      path.resolve(here, "..", "..", "..", "package.json"),
    ];
    for (const p of candidates) {
      if (!fs.existsSync(p)) continue;
      const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
      if (pkg.name === "scriipture") return pkg.version ?? "0.0.0";
    }
  } catch { /* fall through */ }
  return "0.0.0";
}

export function writeAttestation(outPath: string, bundle: AttestationBundle): string {
  const json = JSON.stringify(bundle, null, 2);
  fs.writeFileSync(outPath, json, "utf8");
  return sha256(json);
}

export function attestationFingerprint(bundle: AttestationBundle): string {
  const canonical = JSON.stringify(bundle, Object.keys(bundle).sort());
  return sha256(canonical);
}

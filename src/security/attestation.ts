import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export interface ToolVersion {
  name: string;
  version: string;
}

export interface GateResult {
  name: string;
  passed: boolean;
  detail?: string;
  findings?: number;
}

export interface AttestationBundle {
  schemaVersion: 1;
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
  const r = spawnSync(cmd, [flag], { encoding: "utf8" });
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

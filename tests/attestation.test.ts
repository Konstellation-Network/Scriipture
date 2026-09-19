import { describe, it, expect } from "bun:test";
import {
  gatePassed,
  gateFailed,
  gateSkipped,
  gateNotApplicable,
  unjustifiedSkippedGates,
} from "../src/security/attestation";
import { applySkipList } from "../src/cli/verify";

describe("attestation — gate status", () => {
  it("only a gate that ran clean reads as passed", () => {
    expect(gatePassed("slither").passed).toBe(true);
    expect(gateFailed("slither").passed).toBe(false);
    expect(gateSkipped("slither", "skipped (--no-slither)").passed).toBe(false);
    expect(gateNotApplicable("invariant-tests", "none declared").passed).toBe(false);
  });

  it("records the status explicitly", () => {
    expect(gatePassed("x").status).toBe("passed");
    expect(gateFailed("x").status).toBe("failed");
    expect(gateSkipped("x", "r").status).toBe("skipped");
    expect(gateNotApplicable("x", "r").status).toBe("not-applicable");
  });

  it("keeps the justification and opt-in flag on skipped gates", () => {
    const g = gateSkipped("smt-checker", "skipped (--no-smt)", { justification: "SMT times out on this contract; see issue #42" });
    expect(g.justification).toBe("SMT times out on this contract; see issue #42");
    expect(g.optIn).toBeUndefined();
    expect(gateSkipped("mythril", "opt-in", { optIn: true }).optIn).toBe(true);
  });

  it("flags skipped gates that are neither justified nor opt-in", () => {
    const gates = [
      gatePassed("native-validator"),
      gateSkipped("mythril", "opt-in (--deep not set)", { optIn: true }),
      gateSkipped("slither", "skipped (--no-slither)"),
      gateSkipped("smt-checker", "skipped (--no-smt)", { justification: "documented in RUNBOOK.md" }),
      gateNotApplicable("invariant-tests", "none declared"),
      gateFailed("fuzz-run", "forge test failed"),
    ];
    expect(unjustifiedSkippedGates(gates).map((g) => g.name)).toEqual(["slither"]);
  });

  it("applySkipList maps --skip names onto the no-* flags", () => {
    const o = applySkipList({ skip: ["fuzz,invariants", " Slither "] });
    expect(o.noFuzz).toBe(true);
    expect(o.noInvariants).toBe(true);
    expect(o.noSlither).toBe(true);
    expect(o.noSmt).toBeFalsy();
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeploymentBytecodeMismatch, stampDeployment, writeAttestation, type AttestationBundle } from "../src/security/attestation";

describe("attestation — deployment stamp", () => {
  const bundleFor = (deployedBytecode?: string): AttestationBundle => ({
    schemaVersion: 2, contract: "X",
    hashes: { tsSource: "a", solSource: "b", bytecode: "c", deployedBytecode },
    tools: [], gates: [gatePassed("solc-compile")], optimizations: [], diagnostics: [],
    generatedAt: "t", generatedBy: "scriipture@test",
  });
  const write = (bundle: AttestationBundle) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-att-"));
    const p = path.join(dir, "X.attestation.json");
    return { p, fingerprint: writeAttestation(p, bundle) };
  };

  it("records network, address, tx and both bytecode hashes, and changes the fingerprint", () => {
    const { p, fingerprint: before } = write(bundleFor("verified-hash"));
    const after = stampDeployment(p, {
      network: "base-sepolia", address: "0xabc", txHash: "0xdef", deployedAt: "t2",
      artifactDeployedBytecode: "verified-hash",
      onchainDeployedBytecode: "onchain-hash",
      onchainMatchesArtifact: false,
    });
    expect(after).not.toBe(before);
    const stored = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(stored.network).toBe("base-sepolia");
    expect(stored.address).toBe("0xabc");
    expect(stored.deployment.artifactDeployedBytecode).toBe("verified-hash");
    expect(stored.deployment.onchainDeployedBytecode).toBe("onchain-hash");
    expect(stored.deployment.onchainMatchesArtifact).toBe(false);
    expect(stored.gates).toHaveLength(1); // nothing else touched
  });

  it("refuses to stamp bytecode the gates never saw, and leaves the bundle untouched", () => {
    const { p } = write(bundleFor("verified-hash"));
    expect(() => stampDeployment(p, {
      network: "base", address: "0xabc", txHash: "0xdef", deployedAt: "t2",
      artifactDeployedBytecode: "some-other-contract",
    })).toThrow(DeploymentBytecodeMismatch);
    const stored = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(stored.address).toBeUndefined();
    expect(stored.deployment).toBeUndefined();
  });

  it("refuses when the attestation carries no deployed-bytecode hash at all", () => {
    const { p } = write(bundleFor(undefined));
    expect(() => stampDeployment(p, {
      network: "base", address: "0xabc", txHash: "0xdef", deployedAt: "t2",
      artifactDeployedBytecode: "anything",
    })).toThrow(/no deployed-bytecode hash/);
  });
});

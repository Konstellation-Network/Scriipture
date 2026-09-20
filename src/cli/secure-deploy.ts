import pc from "picocolors";
import { verifyCommand } from "./verify";
import { deployCommand, maybeVerifySource, readArtifact } from "./deploy";
import { DeploymentBytecodeMismatch, assertVerifiedBytecode, sha256, stampDeployment, unjustifiedSkippedGates } from "../security/attestation";

export interface SecureDeployOptions {
  network: string;
  args?: string[];
  artifacts?: string;
  contract: string;
  noFuzz?: boolean;
  noSmt?: boolean;
  noSlither?: boolean;
  noInvariants?: boolean;
  noPatterns?: boolean;
  deep?: boolean;
  skip?: string[];
  fuzzRuns?: number;
  mythrilTimeout?: number;
  /** Reason for deploying with one or more gates switched off; recorded on each skipped gate. */
  allowSkippedGates?: string;
}

export async function secureDeployCommand(input: string, opts: SecureDeployOptions): Promise<void> {
  console.log(pc.bold("Stage 1/2 — verify (running all gates)"));
  const verify = await verifyCommand(input, { ...opts, skipJustification: opts.allowSkippedGates });
  if (!verify.ok) {
    console.error(pc.red("\n✗ verification failed; refusing to deploy."));
    process.exit(1);
  }

  const unjustified = unjustifiedSkippedGates(verify.gates);
  if (unjustified.length > 0) {
    const names = Array.from(new Set(unjustified.map((g) => g.name))).join(", ");
    console.error(pc.red(`\n✗ ${unjustified.length} gate result(s) skipped without justification: ${names}`));
    console.error(pc.red("  An attestation that cannot tell \"clean\" from \"never ran\" is not an attestation."));
    console.error(pc.red("  Re-run without the --no-* flags, or pass --allow-skipped-gates \"<reason>\" to record why these gates were skipped."));
    process.exit(1);
  }
  if (opts.allowSkippedGates) {
    const skipped = verify.gates.filter((g) => g.status === "skipped" && !g.optIn);
    if (skipped.length > 0) {
      const names = Array.from(new Set(skipped.map((g) => g.name))).join(", ");
      console.log(pc.yellow(`\n⚠ deploying with skipped gate(s): ${names}`));
      console.log(pc.yellow(`  justification recorded in attestation: "${opts.allowSkippedGates}"`));
    }
  }

  // Check this before deploying, not after: a name that has no attestation
  // must not reach the chain and then be reported as unrecordable.
  const att = verify.attestations.find((a) => a.contract === opts.contract);
  if (!att) {
    const known = verify.attestations.map((a) => a.contract).join(", ") || "none";
    console.error(pc.red(`\n✗ no attestation was written for "${opts.contract}"; refusing to deploy something the gates did not cover.`));
    console.error(pc.red(`  verified in this run: ${known}`));
    process.exit(1);
  }

  // Deploy the artifact `verify` just compiled, not whatever `compile` last
  // left on disk: a stale file would put unverified bytecode on chain under
  // the cover of a passing attestation. `--artifacts` overrides that, so hash
  // whatever will actually be sent and compare it with the attestation now --
  // `stampDeployment` repeats the check, but by then the bytecode is on chain.
  const artifactsDir = opts.artifacts ?? verify.artifactsDir;
  const artifact = readArtifact(artifactsDir, opts.contract);
  try {
    assertVerifiedBytecode(att.path, sha256(artifact.deployedBytecode));
  } catch (err) {
    if (err instanceof DeploymentBytecodeMismatch) {
      console.error(pc.red(`\n✗ refusing to deploy: ${err.message}`));
      console.error(pc.red(`  artifact: ${artifactsDir}/${opts.contract}.json — nothing was sent.`));
      process.exit(1);
    }
    throw err;
  }

  console.log("");
  console.log(pc.bold("Stage 2/2 — deploy"));
  const args = opts.args ?? [];
  const outcome = await deployCommand(opts.contract, {
    network: opts.network,
    args,
    artifacts: artifactsDir,
    deferSourceVerify: true,
  });

  // Tie the gate results to the deployment they cleared.
  try {
    const fingerprint = stampDeployment(att.path, {
      network: outcome.network,
      address: outcome.address,
      txHash: outcome.txHash,
      from: outcome.from,
      deployedAt: new Date().toISOString(),
      artifactDeployedBytecode: outcome.artifactDeployedBytecode,
      onchainDeployedBytecode: outcome.onchainDeployedBytecode,
      onchainMatchesArtifact: outcome.onchainMatchesArtifact,
    });
    console.log(`  attestation: ${att.path}`);
    console.log(`    fingerprint: ${pc.dim(fingerprint.slice(0, 16) + "…")} (now records ${outcome.network} @ ${outcome.address})`);
    if (outcome.onchainMatchesArtifact === true) {
      console.log(`    on-chain code matches the verified bytecode`);
    } else if (outcome.onchainMatchesArtifact === false) {
      console.log(pc.yellow(`    ⚠ on-chain code differs from the compiled deployedBytecode — expected when the contract has immutables or linked libraries; both hashes are recorded`));
    } else {
      console.log(pc.dim(`    (eth_getCode returned no code at the address, or the node could not be reached; on-chain hash not recorded)`));
    }
  } catch (err) {
    if (err instanceof DeploymentBytecodeMismatch) {
      console.error(pc.red(`\n✗ refusing to stamp: ${err.message}`));
      console.error(pc.red(`  deployed at ${outcome.address} on ${outcome.network} (tx ${outcome.txHash}); the attestation was left unstamped.`));
      process.exit(1);
    }
    throw err;
  }

  await maybeVerifySource(outcome);
}

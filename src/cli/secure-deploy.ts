import pc from "picocolors";
import { verifyCommand } from "./verify";
import { deployCommand } from "./deploy";
import { unjustifiedSkippedGates } from "../security/attestation";

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

  console.log("");
  console.log(pc.bold("Stage 2/2 — deploy"));
  await deployCommand(opts.contract, {
    network: opts.network,
    args: opts.args ?? [],
    artifacts: opts.artifacts,
  });
}

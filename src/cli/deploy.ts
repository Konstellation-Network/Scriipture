import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { loadConfig } from "../config/load";
import type { CompiledArtifact } from "../compiler/solc";
import { deploy } from "../deploy/deployer";
import { loadWallet } from "../wallet/store";
import { browserDeploy } from "../wallet/browser-deploy";
import type { Abi, Hex } from "viem";

export interface DeployOptions {
  network: string;
  args?: string[];
  artifacts?: string;
  wallet?: string;
  rpc?: string;
  browser?: boolean;
  verify?: boolean;
}

export interface DeployOutcome {
  contractName: string;
  network: string;
  address: Hex;
  txHash: Hex;
  from?: Hex;
}

export async function deployCommand(input: string, opts: DeployOptions): Promise<DeployOutcome> {
  const config = await loadConfig();
  const artifactsDir = path.resolve(opts.artifacts ?? path.join(config.outDir, "artifacts"));
  const contractName = path.basename(input);
  const artifactPath = path.join(artifactsDir, `${contractName}.json`);

  if (!fs.existsSync(artifactPath)) {
    console.error(`Artifact not found: ${artifactPath}. Run "scriipture compile" first.`);
    process.exit(1);
  }

  const artifact: CompiledArtifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const args = (opts.args ?? []).map(decodeArg);

  const useBrowser = opts.browser ?? (!opts.wallet && opts.network !== "anvil");

  let txHash: Hex, address: Hex, from: Hex | undefined;
  if (useBrowser) {
    console.log(pc.dim(`browser-wallet deploy: opening your browser to sign…`));
    const r = await browserDeploy({
      contractName,
      network: opts.network,
      rpcUrl: opts.rpc,
      abi: artifact.abi as Abi,
      bytecode: artifact.bytecode as Hex,
      args,
    });
    txHash = r.txHash; address = r.contractAddress; from = r.from;
  } else {
    let privateKeyOverride: Hex | undefined;
    if (opts.wallet) {
      const w = loadWallet(opts.wallet);
      privateKeyOverride = w.privateKey;
      console.log(pc.dim(`using wallet "${opts.wallet}" (${w.address})`));
    }
    console.log(pc.dim(`deploying ${contractName} to ${opts.network}…`));
    const result = await deploy({ artifact, network: opts.network, config, args, privateKeyOverride, rpcOverride: opts.rpc });
    txHash = result.txHash; address = result.contractAddress;
  }

  console.log(pc.green(`✓ deployed ${contractName}`));
  console.log(`  network:  ${opts.network}`);
  console.log(`  tx:       ${txHash}`);
  console.log(`  address:  ${address}`);
  if (from) console.log(`  from:     ${from}`);

  writeDeployLog(opts.network, contractName, { address, txHash, args, from });

  const { getEtherscanKey } = await import("../config/user-store");
  const shouldVerify = opts.verify ?? (
    !!getEtherscanKey() && opts.network !== "anvil"
  );
  if (shouldVerify) {
    const { verifySourceCommand } = await import("./verify-source");
    await verifySourceCommand(contractName, { network: opts.network, address, args });
  } else if (opts.network !== "anvil" && !getEtherscanKey()) {
    console.log(pc.dim(`(skip verify: set etherscan-key via 'scriipture config set etherscan-key <KEY>')`));
  }

  return { contractName, network: opts.network, address, txHash, from };
}

function writeDeployLog(network: string, contractName: string, info: { address: Hex; txHash: Hex; args: unknown[]; from?: Hex }): void {
  const dir = path.resolve("out/deploy-log", network);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${contractName}.json`);
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { history: [] };
  const entry = { ...info, args: info.args.map((a) => typeof a === "bigint" ? a.toString() : a), timestamp: new Date().toISOString() };
  existing.history.unshift(entry);
  existing.latest = entry;
  fs.writeFileSync(file, JSON.stringify(existing, null, 2), "utf8");
}

function decodeArg(raw: string): unknown {
  if (/^[0-9]+$/.test(raw)) return BigInt(raw);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw;
}

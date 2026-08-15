import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { verifyOnEtherscan } from "../verify/etherscan";
import { getEtherscanKey } from "../config/user-store";
import type { Hex } from "viem";

export interface VerifySourceOptions {
  network: string;
  address?: Hex;
  args?: unknown[];
  apiKey?: string;
}

export async function verifySourceCommand(contractName: string, opts: VerifySourceOptions): Promise<void> {
  const apiKey = getEtherscanKey(opts.apiKey);
  if (!apiKey) {
    console.error(pc.red("✗ no Etherscan API key configured."));
    console.error("");
    console.error("Set one (one-time, ~30 seconds):");
    console.error(pc.cyan("  1. Get a free key at https://etherscan.io/myapikey"));
    console.error(pc.cyan("  2. scriipture config set etherscan-key YOUR_KEY"));
    console.error("");
    console.error(pc.dim("The same key works for every chain Etherscan covers (Base, Arbitrum, Optimism, Polygon, etc.)"));
    console.error(pc.dim("Alternatives: --api-key flag, or ETHERSCAN_API_KEY env var."));
    process.exit(1);
  }

  let address = opts.address;
  let args = opts.args;

  if (!address || !args) {
    const logPath = path.resolve("out/deploy-log", opts.network, `${contractName}.json`);
    if (!fs.existsSync(logPath)) {
      console.error(pc.red(`✗ no deploy log at ${logPath}. Pass --address and --args explicitly.`));
      process.exit(1);
    }
    const log = JSON.parse(fs.readFileSync(logPath, "utf8"));
    address = address ?? (log.latest?.address as Hex);
    args = args ?? log.latest?.args ?? [];
  }

  console.log(pc.bold(`verifying ${contractName} on ${opts.network}…`));
  console.log(pc.dim(`  address: ${address}`));
  const r = await verifyOnEtherscan({
    contractName,
    network: opts.network,
    address: address!,
    constructorArgs: args ?? [],
    apiKey,
  });

  if (r.ok) {
    console.log(pc.green(`✓ ${r.message}`));
    if (r.url) console.log(pc.cyan(`  ${r.url}`));
  } else {
    console.error(pc.red(`✗ ${r.message}`));
    process.exit(1);
  }
}

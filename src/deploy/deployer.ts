import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import type { CompiledArtifact } from "../compiler/solc";
import type { Config, NetworkConfig } from "../config/schema";
import { resolveChain } from "./networks";

export interface DeployInput {
  artifact: CompiledArtifact;
  network: string;
  config: Config;
  args?: unknown[];
  privateKeyOverride?: Hex;
  rpcOverride?: string;
}

export interface DeployResult {
  txHash: Hex;
  contractAddress: Hex;
  network: string;
  contractName: string;
}

export async function deploy({ artifact, network, config, args = [], privateKeyOverride, rpcOverride }: DeployInput): Promise<DeployResult> {
  const netConf = config.networks[network] ?? defaultNetworkFor(network);
  const chain = resolveChain(network, config.networks) as any;
  const privateKey = privateKeyOverride ?? readPrivateKey(netConf);
  const account = privateKeyToAccount(privateKey);
  const rpcUrl = rpcOverride ?? netConf.rpcUrl ?? chain?.rpcUrls?.default?.http?.[0];
  if (!rpcUrl) throw new Error(`no RPC URL for network "${network}"`);

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain, transport: http(rpcUrl), account });

  const hash = await walletClient.deployContract({
    abi: artifact.abi as never,
    bytecode: artifact.bytecode as Hex,
    args: args as never,
    account,
    chain,
  } as any);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("deploy receipt missing contractAddress");

  return {
    txHash: hash,
    contractAddress: receipt.contractAddress,
    network,
    contractName: artifact.contractName,
  };
}

/**
 * `eth_getCode` at `address`. Used to record what is actually on chain in the
 * attestation; returns undefined when the node cannot be reached rather than
 * failing a deploy that already succeeded.
 */
export async function fetchDeployedCode(
  network: string,
  config: Config,
  address: Hex,
  rpcOverride?: string,
): Promise<Hex | undefined> {
  try {
    const netConf = config.networks[network] ?? defaultNetworkFor(network);
    const chain = resolveChain(network, config.networks) as any;
    const rpcUrl = rpcOverride ?? netConf.rpcUrl ?? chain?.rpcUrls?.default?.http?.[0];
    if (!rpcUrl) return undefined;
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    // Raw request rather than getCode/getBytecode so this does not track viem renames.
    const code = await publicClient.request({ method: "eth_getCode", params: [address, "latest"] } as any);
    return (code as Hex) ?? undefined;
  } catch {
    return undefined;
  }
}

function defaultNetworkFor(name: string): NetworkConfig {
  if (name === "anvil") {
    return { rpcUrl: "http://127.0.0.1:8545", chainId: 31337, privateKeyEnv: "ANVIL_PRIVATE_KEY" };
  }
  if (name === "base-sepolia") {
    return { rpcUrl: "https://sepolia.base.org", chainId: 84532 };
  }
  if (name === "base") {
    return { rpcUrl: "https://mainnet.base.org", chainId: 8453 };
  }
  throw new Error(`Network "${name}" not configured in scriipture.config.ts and no default known.`);
}

function readPrivateKey(net: NetworkConfig): Hex {
  if (!net.privateKeyEnv) {
    throw new Error("network config missing privateKeyEnv");
  }
  let pk = process.env[net.privateKeyEnv];
  if (!pk && net.privateKeyEnv === "ANVIL_PRIVATE_KEY") {
    pk = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  }
  if (!pk) throw new Error(`env var ${net.privateKeyEnv} is not set`);
  if (!pk.startsWith("0x")) pk = "0x" + pk;
  return pk as Hex;
}

import { defineChain } from "viem";
import type { NetworkConfig } from "../config/schema";
import {
  sepolia, mainnet, base, baseSepolia, optimism, optimismSepolia, arbitrum, arbitrumSepolia, polygon, polygonAmoy,
} from "viem/chains";

export const anvil = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

export const CHAINS = {
  anvil,
  sepolia,
  mainnet,
  base,
  "base-sepolia": baseSepolia,
  optimism,
  "optimism-sepolia": optimismSepolia,
  arbitrum,
  "arbitrum-sepolia": arbitrumSepolia,
  polygon,
  "polygon-amoy": polygonAmoy,
};

export type KnownNetwork = keyof typeof CHAINS;

/**
 * Resolve a network name to a viem chain.
 *
 * Built-in chains win; anything else is constructed from the `networks` entry
 * in scriipture.config.mjs, which is why callers should pass `config.networks`.
 * Without it, a fully-specified custom network is unreachable.
 */
export function resolveChain(name: string, networks?: Record<string, NetworkConfig>) {
  const known = (CHAINS as Record<string, unknown>)[name];
  if (known) return known;

  const nc = networks?.[name];
  if (nc) {
    return defineChain({
      id: nc.chainId,
      name,
      nativeCurrency: nc.nativeCurrency ?? { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [nc.rpcUrl] } },
      ...(nc.blockExplorerUrl
        ? { blockExplorers: { default: { name: `${name} explorer`, url: nc.blockExplorerUrl } } }
        : {}),
    });
  }

  const builtins = Object.keys(CHAINS).join(", ");
  throw new Error(
    `Unknown network "${name}". Built-in: ${builtins}. ` +
      `To use another chain, add it under "networks" in scriipture.config.mjs with an rpcUrl and chainId.`,
  );
}

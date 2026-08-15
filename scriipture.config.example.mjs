/** @type {import("scriipture").Config} */
const config = {
  compiler: {
    version: "0.8.20",
    optimizer: { enabled: true, runs: 200 },
  },
  networks: {
    anvil: {
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
      privateKeyEnv: "ANVIL_PRIVATE_KEY",
    },
    "base-sepolia": {
      rpcUrl: "https://sepolia.base.org",
      chainId: 84532,
    },
    base: {
      rpcUrl: "https://mainnet.base.org",
      chainId: 8453,
    },
  },
  outDir: "out",
  plugins: [],
};

export default config;

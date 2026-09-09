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
    // Networks that aren't built in work too -- rpcUrl and chainId are all
    // that's required. nativeCurrency and blockExplorerUrl are optional.
    // myChain: {
    //   rpcUrl: "https://rpc.my-chain.example",
    //   chainId: 424242,
    //   nativeCurrency: { name: "My Token", symbol: "MYT", decimals: 18 },
    //   blockExplorerUrl: "https://explorer.my-chain.example",
    //   privateKeyEnv: "MYCHAIN_PRIVATE_KEY",
    // },
  },
  outDir: "out",
  plugins: [],
};

export default config;

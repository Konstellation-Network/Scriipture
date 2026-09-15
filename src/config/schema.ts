import { z } from "zod";

export const NetworkConfigSchema = z.object({
  rpcUrl: z.string().url(),
  chainId: z.number().int().positive(),
  privateKeyEnv: z.string().optional(),
  // Only needed for networks that are not built in; defaults to ETH/18.
  nativeCurrency: z
    .object({
      name: z.string().default("Ether"),
      symbol: z.string().default("ETH"),
      decimals: z.number().int().positive().default(18),
    })
    .optional(),
  blockExplorerUrl: z.string().url().optional(),
});

export const CompilerConfigSchema = z.object({
  version: z.string().default("0.8.20"),
  optimizer: z
    .object({
      enabled: z.boolean().default(true),
      runs: z.number().int().positive().default(200),
    })
    .default({ enabled: true, runs: 200 }),
});

export const ConfigSchema = z.object({
  compiler: CompilerConfigSchema.default({
    version: "0.8.20",
    optimizer: { enabled: true, runs: 200 },
  }),
  networks: z.record(z.string(), NetworkConfigSchema).default({}),
  outDir: z.string().default("out"),
  plugins: z.array(z.string()).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;
export type NetworkConfig = z.infer<typeof NetworkConfigSchema>;
/** What a `scriipture.config.*` file may export: every field optional, defaults applied on load. */
export type ConfigInput = z.input<typeof ConfigSchema>;

/** Type-checks a config file's export without changing it. */
export function defineConfig(config: ConfigInput): ConfigInput {
  return config;
}

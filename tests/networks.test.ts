import { describe, it, expect } from "bun:test";
import { resolveChain, CHAINS } from "../src/deploy/networks";
import { ConfigSchema } from "../src/config/schema";

const networks = {
  ark: { rpcUrl: "https://rpc.example-ark.io", chainId: 424242, privateKeyEnv: "ARK_PRIVATE_KEY" },
} as any;

describe("resolveChain", () => {
  it("builds a chain from a config-defined network", () => {
    const c = resolveChain("ark", networks) as any;
    expect(c.id).toBe(424242);
    expect(c.name).toBe("ark");
    expect(c.rpcUrls.default.http[0]).toBe("https://rpc.example-ark.io");
    expect(c.nativeCurrency).toEqual({ name: "Ether", symbol: "ETH", decimals: 18 });
  });

  it("honours a custom nativeCurrency and explorer", () => {
    const c = resolveChain("ark", {
      ark: {
        rpcUrl: "https://rpc.example-ark.io",
        chainId: 424242,
        nativeCurrency: { name: "Ark", symbol: "ARK", decimals: 18 },
        blockExplorerUrl: "https://explorer.example-ark.io",
      },
    } as any) as any;
    expect(c.nativeCurrency.symbol).toBe("ARK");
    expect(c.blockExplorers.default.url).toBe("https://explorer.example-ark.io");
  });

  it("keeps built-in chains authoritative", () => {
    expect((resolveChain("base") as any).id).toBe(8453);
    // a config entry does not silently replace a built-in chain's metadata
    expect((resolveChain("base", { base: { rpcUrl: "https://x.invalid", chainId: 999 } } as any) as any).id).toBe(8453);
  });

  it("still rejects genuinely unknown networks, and says how to add one", () => {
    expect(() => resolveChain("nope")).toThrow(/Unknown network "nope"/);
    expect(() => resolveChain("nope")).toThrow(/scriipture\.config\.mjs/);
  });

  it("accepts a custom network through the config schema", () => {
    const parsed = ConfigSchema.parse({
      networks: { ark: { rpcUrl: "https://rpc.example-ark.io", chainId: 424242 } },
    });
    expect(resolveChain("ark", parsed.networks as any)).toBeDefined();
    expect(Object.keys(CHAINS)).not.toContain("ark");
  });
});

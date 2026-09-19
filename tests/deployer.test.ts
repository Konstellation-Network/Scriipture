import { describe, it, expect, afterAll } from "bun:test";
import { fetchDeployedCode } from "../src/deploy/deployer";
import { ConfigSchema } from "../src/config/schema";

// A stand-in RPC node whose eth_getCode answer we control.
function rpcAnswering(result: string) {
  return Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { id: number; method: string };
      return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "eth_getCode" ? result : "0x1" });
    },
  });
}

describe("fetchDeployedCode", () => {
  const servers: ReturnType<typeof Bun.serve>[] = [];
  afterAll(() => { for (const s of servers) s.stop(true); });
  const config = ConfigSchema.parse({});
  const ADDR = "0x5fbdb2315678afecb367f032d93f642f64180aa3" as const;

  it("returns the code the node holds at the address", async () => {
    const s = rpcAnswering("0x6080604052"); servers.push(s);
    expect(await fetchDeployedCode("anvil", config, ADDR, `http://127.0.0.1:${s.port}`)).toBe("0x6080604052");
  });

  it("treats an empty answer as unread, not as the deployed code", async () => {
    // A load-balanced endpoint that lags the receipt returns "0x"; hashing that
    // would record sha256("0x") on the attestation as the on-chain bytecode.
    const s = rpcAnswering("0x"); servers.push(s);
    expect(await fetchDeployedCode("anvil", config, ADDR, `http://127.0.0.1:${s.port}`)).toBeUndefined();
  });

  it("returns undefined when the node cannot be reached", async () => {
    expect(await fetchDeployedCode("anvil", config, ADDR, "http://127.0.0.1:1")).toBeUndefined();
  }, 20_000);
});

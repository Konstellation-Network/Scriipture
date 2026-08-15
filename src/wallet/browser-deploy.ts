import http from "node:http";
import { spawn } from "node:child_process";
import { createPublicClient, encodeDeployData, http as viemHttp } from "viem";
import type { Abi, Hex } from "viem";
import { resolveChain } from "../deploy/networks";

export interface BrowserDeployInput {
  contractName: string;
  network: string;
  rpcUrl?: string;
  abi: Abi;
  bytecode: Hex;
  args: unknown[];
  port?: number;
}

export interface BrowserDeployResult {
  txHash: Hex;
  contractAddress: Hex;
  from: Hex;
  network: string;
  contractName: string;
}

export async function browserDeploy(input: BrowserDeployInput): Promise<BrowserDeployResult> {
  const chain = resolveChain(input.network) as any;
  const rpcUrl = input.rpcUrl ?? chain?.rpcUrls?.default?.http?.[0];
  if (!rpcUrl) throw new Error(`no RPC URL for network "${input.network}"`);

  const deployData = encodeDeployData({
    abi: input.abi,
    bytecode: input.bytecode,
    args: input.args as any,
  });

  const params = {
    contractName: input.contractName,
    networkName: chain.name as string,
    chainIdHex: "0x" + Number(chain.id).toString(16),
    networkAdd: {
      chainId: "0x" + Number(chain.id).toString(16),
      chainName: chain.name,
      nativeCurrency: chain.nativeCurrency,
      rpcUrls: [rpcUrl],
      blockExplorerUrls: chain.blockExplorers?.default?.url ? [chain.blockExplorers.default.url] : [],
    },
    deployData,
  };

  const port = input.port ?? 7654;
  let resolveResult: (r: { txHash?: Hex; from?: Hex; error?: string }) => void;
  const resultP = new Promise<{ txHash?: Hex; from?: Hex; error?: string }>((res) => { resolveResult = res; });

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html());
      return;
    }
    if (req.method === "GET" && req.url === "/params") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(params));
      return;
    }
    if (req.method === "POST" && req.url === "/result") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const data = JSON.parse(body || "{}");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          resolveResult(data);
        } catch {
          res.writeHead(400); res.end("bad json");
        }
      });
      return;
    }
    res.writeHead(404); res.end("not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const url = `http://127.0.0.1:${port}/`;
  openBrowser(url);
  console.log(`opened browser at ${url}`);
  console.log(`waiting for your wallet to sign the deploy tx…`);

  const result = await resultP;
  server.close();

  if (result.error) throw new Error(`browser wallet error: ${result.error}`);
  if (!result.txHash) throw new Error("browser returned no tx hash");

  const publicClient = createPublicClient({ chain, transport: viemHttp(rpcUrl) });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: result.txHash });
  if (!receipt.contractAddress) throw new Error("receipt missing contractAddress");

  return {
    txHash: result.txHash,
    contractAddress: receipt.contractAddress,
    from: result.from!,
    network: input.network,
    contractName: input.contractName,
  };
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" :
              process.platform === "win32" ? "cmd" :
              "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", url] : [url];
  try { spawn(cmd, args, { detached: true, stdio: "ignore" }).unref(); } catch { /* ignore */ }
}

function html(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Scriipture browser deploy</title>
<style>
  body { font-family: -apple-system, "SF Pro Text", Segoe UI, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; color: #222; }
  h1 { font-size: 18px; margin-bottom: 6px; }
  .meta { color: #666; font-size: 13px; }
  button { font-size: 15px; padding: 10px 18px; border-radius: 8px; border: 1px solid #2a6df4; background: #2a6df4; color: white; cursor: pointer; margin-top: 16px; }
  button:disabled { opacity: 0.5; cursor: default; }
  pre { background: #f5f5f5; padding: 12px; border-radius: 8px; font-size: 12px; max-height: 320px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
  .ok { color: #1a7a3a; } .err { color: #b00; }
  code { background: #f5f5f5; padding: 1px 4px; border-radius: 3px; }
</style>
</head>
<body>
<h1 id="title">Scriipture deploy</h1>
<div class="meta" id="meta">loading…</div>
<button id="go" disabled>Connect wallet & deploy</button>
<pre id="log"></pre>
<script>
(async () => {
  const log = (msg, cls) => {
    const el = document.getElementById('log');
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = msg;
    el.appendChild(line);
  };

  let params;
  try {
    params = await fetch('/params').then(r => r.json());
  } catch (e) {
    log('failed to load params: ' + e.message, 'err'); return;
  }

  document.getElementById('title').textContent = 'Deploy ' + params.contractName + ' → ' + params.networkName;
  document.getElementById('meta').textContent = 'chain ' + params.chainIdHex + ' (' + parseInt(params.chainIdHex, 16) + ')';

  const btn = document.getElementById('go');
  btn.disabled = false;
  btn.onclick = async () => {
    btn.disabled = true;
    if (!window.ethereum) {
      log('No injected wallet found. Install MetaMask, Rabby, or Coinbase Wallet.', 'err');
      await fetch('/result', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ error: 'no injected wallet' }) });
      return;
    }
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      log('connected: ' + accounts[0]);

      const currentChain = await window.ethereum.request({ method: 'eth_chainId' });
      if (currentChain !== params.chainIdHex) {
        log('switching to ' + params.chainIdHex + '…');
        try {
          await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: params.chainIdHex }] });
        } catch (e) {
          if (e.code === 4902) {
            log('chain not added, adding…');
            await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [params.networkAdd] });
          } else { throw e; }
        }
      }

      log('sending deploy transaction (sign in your wallet)…');
      const txHash = await window.ethereum.request({
        method: 'eth_sendTransaction',
        params: [{ from: accounts[0], data: params.deployData }]
      });
      log('tx submitted: ' + txHash, 'ok');
      await fetch('/result', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ txHash, from: accounts[0] }) });
      log('CLI notified. You can close this tab.', 'ok');
    } catch (e) {
      log('error: ' + (e.message || String(e)), 'err');
      await fetch('/result', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ error: e.message || String(e) }) });
    }
  };
})();
</script>
</body>
</html>`;
}

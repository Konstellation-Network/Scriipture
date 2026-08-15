import fs from "node:fs";
import path from "node:path";
import { encodeAbiParameters } from "viem";
import type { Abi, AbiParameter, Hex } from "viem";
import { resolveChain } from "../deploy/networks";

const ETHERSCAN_V2 = "https://api.etherscan.io/v2/api";

export interface VerifyInput {
  contractName: string;
  network: string;
  address: Hex;
  constructorArgs: unknown[];
  apiKey: string;
  artifactsDir?: string;
  compilerVersion?: string;
}

export interface VerifyOutcome {
  ok: boolean;
  guid?: string;
  status?: string;
  message: string;
  url?: string;
}

export async function verifyOnEtherscan(input: VerifyInput): Promise<VerifyOutcome> {
  const chain = resolveChain(input.network) as any;
  const chainId = chain.id;
  const artifactsDir = input.artifactsDir ?? path.resolve("out/artifacts");
  const standardJsonPath = path.join(artifactsDir, "solc-input.json");
  if (!fs.existsSync(standardJsonPath)) {
    return { ok: false, message: `solc-input.json not found at ${standardJsonPath}; run 'scriipture compile' first` };
  }
  const standardJson = fs.readFileSync(standardJsonPath, "utf8");

  const artifactPath = path.join(artifactsDir, `${input.contractName}.json`);
  if (!fs.existsSync(artifactPath)) {
    return { ok: false, message: `artifact not found at ${artifactPath}` };
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const abi: Abi = artifact.abi;

  const ctor = abi.find((x: any) => x.type === "constructor") as any;
  let constructorArgsHex = "";
  if (ctor && ctor.inputs && ctor.inputs.length > 0) {
    const params = ctor.inputs as AbiParameter[];
    const decoded = input.constructorArgs.map((v, i) => coerce(v, params[i]!));
    const encoded = encodeAbiParameters(params, decoded);
    constructorArgsHex = encoded.slice(2);
  }

  const sourceFile = findSourceFileForContract(standardJson, input.contractName);
  if (!sourceFile) {
    return { ok: false, message: `could not find source file for ${input.contractName} in solc-input.json` };
  }
  const contractIdentifier = `${sourceFile}:${input.contractName}`;

  const compilerVersion = input.compilerVersion ?? await detectCompilerVersion(artifact, "0.8.20");

  const form = new URLSearchParams();
  form.set("module", "contract");
  form.set("action", "verifysourcecode");
  form.set("apikey", input.apiKey);
  form.set("sourceCode", standardJson);
  form.set("codeformat", "solidity-standard-json-input");
  form.set("contractaddress", input.address);
  form.set("contractname", contractIdentifier);
  form.set("compilerversion", compilerVersion);
  form.set("constructorArguements", constructorArgsHex);

  const submitUrl = `${ETHERSCAN_V2}?chainid=${chainId}`;
  const submitRes = await fetch(submitUrl, { method: "POST", body: form });
  const submitJson: any = await submitRes.json();

  if (submitJson.status !== "1") {
    if (typeof submitJson.result === "string" && submitJson.result.toLowerCase().includes("already verified")) {
      return { ok: true, message: "already verified", url: explorerUrl(chain, input.address) };
    }
    return { ok: false, message: `submit failed: ${submitJson.result ?? submitJson.message}` };
  }

  const guid = submitJson.result as string;

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const checkUrl = `${ETHERSCAN_V2}?chainid=${chainId}&module=contract&action=checkverifystatus&guid=${guid}&apikey=${input.apiKey}`;
    const checkRes = await fetch(checkUrl);
    const checkJson: any = await checkRes.json();
    const result = String(checkJson.result ?? "");
    if (result.toLowerCase().includes("pass") || result.toLowerCase().includes("verified")) {
      return { ok: true, guid, status: result, message: result, url: explorerUrl(chain, input.address) };
    }
    if (result.toLowerCase().includes("fail")) {
      return { ok: false, guid, status: result, message: result };
    }
    if (result.toLowerCase().includes("pending")) continue;
  }
  return { ok: false, guid, message: "verification timed out after 2 minutes" };
}

function coerce(v: unknown, p: AbiParameter): unknown {
  if (p.type.startsWith("uint") || p.type.startsWith("int")) {
    if (typeof v === "string") return BigInt(v);
    if (typeof v === "number") return BigInt(v);
    return v;
  }
  if (p.type === "bool") {
    if (typeof v === "string") return v === "true";
    return v;
  }
  return v;
}

function findSourceFileForContract(standardJsonText: string, contractName: string): string | null {
  const json = JSON.parse(standardJsonText);
  const sources = json.sources ?? {};
  for (const filename of Object.keys(sources)) {
    if (!filename.endsWith(".sol")) continue;
    const content = sources[filename].content as string;
    const re = new RegExp(`(?:contract|abstract\\s+contract|interface|library)\\s+${escapeRegex(contractName)}\\b`);
    if (re.test(content)) return filename;
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function detectCompilerVersion(_artifact: any, fallback: string): Promise<string> {
  return await resolveFullVersion(fallback);
}

const VERSION_CACHE: Record<string, string> = {};

async function resolveFullVersion(short: string): Promise<string> {
  if (VERSION_CACHE[short]) return VERSION_CACHE[short]!;
  try {
    const res = await fetch("https://binaries.soliditylang.org/bin/list.json");
    const list: any = await res.json();
    const releases = list.releases as Record<string, string>;
    const file = releases[short];
    if (file) {
      const v = file.replace(/^soljson-/, "").replace(/\.js$/, "");
      VERSION_CACHE[short] = v;
      return v;
    }
  } catch { /* fall through */ }
  return `v${short}+commit.0`;
}

function explorerUrl(chain: any, address: string): string | undefined {
  const base = chain?.blockExplorers?.default?.url;
  return base ? `${base}/address/${address}#code` : undefined;
}

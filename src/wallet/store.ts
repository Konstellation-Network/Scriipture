import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

export const WALLET_DIR = path.join(os.homedir(), ".scriipture", "wallets");

export interface WalletRecord {
  name: string;
  address: Hex;
  privateKey: Hex;
  createdAt: string;
  notes?: string;
}

export function ensureWalletDir(): void {
  fs.mkdirSync(WALLET_DIR, { recursive: true, mode: 0o700 });
}

export function walletPath(name: string): string {
  return path.join(WALLET_DIR, `${name}.json`);
}

export function createWallet(name: string): WalletRecord {
  ensureWalletDir();
  const file = walletPath(name);
  if (fs.existsSync(file)) throw new Error(`wallet "${name}" already exists at ${file}`);
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  const record: WalletRecord = {
    name,
    address: account.address,
    privateKey: pk,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return record;
}

export function loadWallet(name: string): WalletRecord {
  const file = walletPath(name);
  if (!fs.existsSync(file)) throw new Error(`wallet "${name}" not found at ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function listWallets(): WalletRecord[] {
  if (!fs.existsSync(WALLET_DIR)) return [];
  const out: WalletRecord[] = [];
  for (const entry of fs.readdirSync(WALLET_DIR)) {
    if (!entry.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(WALLET_DIR, entry), "utf8")));
    } catch { /* skip */ }
  }
  return out;
}

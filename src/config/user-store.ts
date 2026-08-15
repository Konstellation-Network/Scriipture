import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const USER_CONFIG_DIR = path.join(os.homedir(), ".scriipture");
export const USER_CONFIG_FILE = path.join(USER_CONFIG_DIR, "config.json");

const KNOWN_KEYS = [
  "etherscan-key",
  "default-network",
  "default-rpc",
] as const;

export type UserConfig = Partial<Record<string, string>>;

export function loadUserConfig(): UserConfig {
  if (!fs.existsSync(USER_CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(USER_CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function saveUserConfig(cfg: UserConfig): void {
  fs.mkdirSync(USER_CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(USER_CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.chmodSync(USER_CONFIG_FILE, 0o600);
}

export function setUserConfig(key: string, value: string): void {
  const cfg = loadUserConfig();
  cfg[key] = value;
  saveUserConfig(cfg);
}

export function getUserConfig(key: string): string | undefined {
  return loadUserConfig()[key];
}

export function unsetUserConfig(key: string): void {
  const cfg = loadUserConfig();
  delete cfg[key];
  saveUserConfig(cfg);
}

export function knownKeys(): readonly string[] {
  return KNOWN_KEYS;
}

export function getEtherscanKey(override?: string): string | undefined {
  if (override) return override;
  if (process.env.ETHERSCAN_API_KEY) return process.env.ETHERSCAN_API_KEY;
  if (process.env.BASESCAN_API_KEY) return process.env.BASESCAN_API_KEY;
  return getUserConfig("etherscan-key");
}

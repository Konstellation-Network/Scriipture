import pc from "picocolors";
import {
  USER_CONFIG_FILE,
  knownKeys,
  loadUserConfig,
  setUserConfig,
  unsetUserConfig,
} from "../config/user-store";

const SENSITIVE = new Set(["etherscan-key"]);

function maskValue(key: string, value: string): string {
  if (!SENSITIVE.has(key)) return value;
  if (value.length <= 6) return "*".repeat(value.length);
  return value.slice(0, 3) + "…" + value.slice(-3) + pc.dim(`  (${value.length} chars)`);
}

export async function configSetCommand(key: string, value: string): Promise<void> {
  setUserConfig(key, value);
  console.log(pc.green(`✓ set ${key}`) + pc.dim(`   stored at ${USER_CONFIG_FILE} (mode 0600)`));
}

export async function configGetCommand(key: string): Promise<void> {
  const v = loadUserConfig()[key];
  if (v === undefined) {
    console.error(pc.red(`✗ ${key} is not set`));
    process.exit(1);
  }
  console.log(maskValue(key, v));
}

export async function configListCommand(opts: { revealKeys?: boolean }): Promise<void> {
  const cfg = loadUserConfig();
  const keys = new Set([...knownKeys(), ...Object.keys(cfg)]);
  if (keys.size === 0) {
    console.log(pc.dim("no config set yet — use `scriipture config set <key> <value>`"));
    return;
  }
  for (const k of keys) {
    const v = cfg[k];
    if (v === undefined) {
      console.log(`  ${pc.dim(k.padEnd(20))} ${pc.dim("(unset)")}`);
    } else {
      const display = opts.revealKeys ? v : maskValue(k, v);
      console.log(`  ${pc.bold(k.padEnd(20))} ${display}`);
    }
  }
  console.log(pc.dim(`\nstored at: ${USER_CONFIG_FILE}`));
}

export async function configUnsetCommand(key: string): Promise<void> {
  unsetUserConfig(key);
  console.log(pc.green(`✓ unset ${key}`));
}

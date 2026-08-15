import fs from "node:fs";
import path from "node:path";
import { ConfigSchema, type Config } from "./schema";

const CONFIG_NAMES = [
  "scriipture.config.mjs",
  "scriipture.config.js",
  "scriipture.config.ts",
  "scriipture.config.json",
];

export async function loadConfig(cwd: string = process.cwd()): Promise<Config> {
  for (const name of CONFIG_NAMES) {
    const full = path.join(cwd, name);
    if (!fs.existsSync(full)) continue;
    if (name.endsWith(".json")) {
      const raw = JSON.parse(fs.readFileSync(full, "utf8"));
      return ConfigSchema.parse(raw);
    }
    if (name.endsWith(".ts")) {
      try {
        const mod = await import(/* @vite-ignore */ full);
        return ConfigSchema.parse(mod.default ?? mod);
      } catch (err) {
        console.warn(`warning: .ts config requires a TS-aware runtime (Bun or ts-node). Falling back to defaults. Consider renaming to .mjs.`);
        return ConfigSchema.parse({});
      }
    }
    const mod = await import(/* @vite-ignore */ full);
    const exported = mod.default ?? mod;
    return ConfigSchema.parse(exported);
  }
  return ConfigSchema.parse({});
}

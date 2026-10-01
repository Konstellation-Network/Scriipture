#!/usr/bin/env node
import { loadConfig } from "../config/load";
import { loadPlugins } from "../plugin/loader";
import { program } from "./program";

try {
  const cfg = await loadConfig();
  if (cfg.plugins && cfg.plugins.length > 0) await loadPlugins(cfg.plugins);
} catch { /* config issues are non-fatal at startup */ }

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});

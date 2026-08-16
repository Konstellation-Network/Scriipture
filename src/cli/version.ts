import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Version of the scriipture package this CLI is running from.
 *
 * Returns undefined when it cannot be resolved, so callers can pick a fallback
 * that makes sense for their use — a display string for `--version`, a
 * satisfiable range for a generated dependency.
 */
export function getScriiptureVersion(): string | undefined {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const candidate of [
      path.resolve(here, "..", "..", "package.json"),
      path.resolve(here, "..", "package.json"),
    ]) {
      if (!fs.existsSync(candidate)) continue;
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (pkg.name === "scriipture" && typeof pkg.version === "string") return pkg.version;
    }
  } catch { /* fall through */ }
  return undefined;
}

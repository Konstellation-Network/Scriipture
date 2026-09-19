import { describe, it, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSlither } from "../src/audit/slither";

const ROOT = path.resolve(__dirname, "..");
const SOL = path.join(ROOT, "tests/contracts/fixtures-smt.sol");
const ORIGINAL_PATH = process.env.PATH;
afterEach(() => { process.env.PATH = ORIGINAL_PATH; });

/** Stand in for slither on PATH; resolveTool prefers a PATH hit over Docker. */
function withFakeSlither(body: string, fn: () => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-fakeslither-"));
  fs.writeFileSync(path.join(dir, "slither"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  process.env.PATH = `${dir}${path.delimiter}${ORIGINAL_PATH}`;
  return fn().finally(() => { process.env.PATH = ORIGINAL_PATH; });
}

describe("a file Slither could not analyse is not a clean file", () => {
  it("records a crash as a failure rather than zero findings", async () => {
    await withFakeSlither('echo "Traceback: solc failed" 1>&2; exit 1', async () => {
      const r = await runSlither([SOL], []);
      expect(r.installed).toBe(true);
      expect(r.ok).toBe(false);
      expect(r.findings).toEqual([]);
      expect(r.failures).toHaveLength(1);
      expect(r.failures[0]!.file).toBe("fixtures-smt.sol");
      expect(r.failures[0]!.reason).toContain("solc failed");
    });
  }, 60_000);

  it("records slither's own success:false as a failure", async () => {
    await withFakeSlither(`echo '{"success": false, "error": "Invalid compilation", "results": {}}'`, async () => {
      const r = await runSlither([SOL], []);
      expect(r.ok).toBe(false);
      expect(r.failures[0]!.reason).toContain("Invalid compilation");
    });
  }, 60_000);

  it("still reports a genuinely clean analysis as ok", async () => {
    await withFakeSlither(`echo '{"success": true, "error": null, "results": {"detectors": []}}'`, async () => {
      const r = await runSlither([SOL], []);
      expect(r.ok).toBe(true);
      expect(r.failures).toEqual([]);
      expect(r.findings).toEqual([]);
    });
  }, 60_000);

  it("still parses findings", async () => {
    const detector = JSON.stringify({
      success: true, error: null,
      results: { detectors: [{
        check: "reentrancy-eth", impact: "High", description: "Reentrancy in f()\\nmore",
        elements: [{ source_mapping: { filename_used: "fixtures-smt.sol", lines: [7] } }],
      }] },
    });
    await withFakeSlither(`cat <<'J'\n${detector}\nJ`, async () => {
      const r = await runSlither([SOL], []);
      expect(r.ok).toBe(true);
      expect(r.findings).toHaveLength(1);
      expect(r.findings[0]!.rule).toBe("reentrancy-eth");
      expect(r.findings[0]!.severity).toBe("error");
    });
  }, 60_000);
});

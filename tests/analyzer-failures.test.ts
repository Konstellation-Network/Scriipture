import { describe, it, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSlither } from "../src/audit/slither";
import { runMythril } from "../src/audit/mythril";

const ROOT = path.resolve(__dirname, "..");
const SOL = path.join(ROOT, "tests/contracts/fixtures-smt.sol");
const ORIGINAL_PATH = process.env.PATH;
afterEach(() => { process.env.PATH = ORIGINAL_PATH; });

/** Stand in for an analyser on PATH; resolveTool prefers a PATH hit over Docker. */
function withFakeTool(name: string, body: string, fn: () => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `scriipture-fake${name}-`));
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  process.env.PATH = `${dir}${path.delimiter}${ORIGINAL_PATH}`;
  return fn().finally(() => { process.env.PATH = ORIGINAL_PATH; });
}
const withFakeSlither = (body: string, fn: () => Promise<void>) => withFakeTool("slither", body, fn);
const withFakeMyth = (body: string, fn: () => Promise<void>) => withFakeTool("myth", body, fn);

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

describe("a file Mythril could not analyse is not a clean file", () => {
  // What `myth analyze -o jsonv2` prints on a fatal error: valid JSON, no issues, exit 0.
  const fatal = JSON.stringify([{
    issues: [], sourceType: "", sourceFormat: "", sourceList: [],
    meta: { logs: [{ level: "error", hidden: true, msg: "Solc experienced a fatal error.\n\nParserError: Expected identifier" }] },
  }]);

  it("records an error reported inside jsonv2 output as a failure, not zero findings", async () => {
    await withFakeMyth(`cat <<'J'\n${fatal}\nJ`, async () => {
      const r = await runMythril([SOL], []);
      expect(r.installed).toBe(true);
      expect(r.ok).toBe(false);
      expect(r.findings).toEqual([]);
      expect(r.failures).toHaveLength(1);
      expect(r.failures[0]!.file).toBe("fixtures-smt.sol");
      expect(r.failures[0]!.reason).toContain("Solc experienced a fatal error");
    });
  }, 60_000);

  it("records the json shape's success:false as a failure", async () => {
    await withFakeMyth(`echo '{"success": false, "error": "Solc version 0.8.20 not found", "issues": []}'`, async () => {
      const r = await runMythril([SOL], []);
      expect(r.ok).toBe(false);
      expect(r.failures[0]!.reason).toContain("Solc version 0.8.20 not found");
    });
  }, 60_000);

  it("records a crash with no JSON as a failure", async () => {
    await withFakeMyth('echo "Traceback (most recent call last): boom" 1>&2; exit 1', async () => {
      const r = await runMythril([SOL], []);
      expect(r.ok).toBe(false);
      expect(r.failures[0]!.reason).toContain("Traceback");
    });
  }, 60_000);

  it("records empty valid JSON with a non-zero exit as a failure", async () => {
    await withFakeMyth(`echo '[{"issues": [], "meta": {"logs": []}}]'; exit 1`, async () => {
      const r = await runMythril([SOL], []);
      expect(r.ok).toBe(false);
      expect(r.failures[0]!.reason).toContain("mythril exited 1");
    });
  }, 60_000);

  it("still reports a genuinely clean analysis as ok", async () => {
    await withFakeMyth(`echo '[{"issues": [], "sourceType": "solidity-file", "sourceFormat": "text", "sourceList": ["fixtures-smt.sol"], "meta": {"logs": [{"level": "info", "msg": "analysis complete"}]}}]'`, async () => {
      const r = await runMythril([SOL], []);
      expect(r.ok).toBe(true);
      expect(r.failures).toEqual([]);
      expect(r.findings).toEqual([]);
    });
  }, 60_000);

  it("still parses findings", async () => {
    const report = JSON.stringify([{
      issues: [{
        "swc-id": "107", title: "External Call To User-Supplied Address", severity: "Low",
        description: { head: "A call to a user-supplied address is executed.", tail: "" },
        locations: [{ sourceMap: "0:10:0", line: 5 }],
      }],
      meta: { logs: [] },
    }]);
    await withFakeMyth(`cat <<'J'\n${report}\nJ`, async () => {
      const r = await runMythril([SOL], []);
      expect(r.ok).toBe(true);
      expect(r.findings).toHaveLength(1);
      expect(r.findings[0]!.swcId).toBe("107");
      expect(r.findings[0]!.severity).toBe("info");
    });
  }, 60_000);
});

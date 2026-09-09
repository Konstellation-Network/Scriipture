import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runForgeTests } from "../src/test-runner/forge-bridge";

const ROOT = path.resolve(__dirname, "..");

describe("forge bridge — tested artifact matches built artifact", () => {
  it("runs the optimizer over contracts under test", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-forge-"));

    // No test files, so this returns before spawning forge -- but the contract
    // sources are written first, which is what we are asserting on.
    const result = await runForgeTests({
      testsGlob: path.join(root, "nonexistent"),
      contractsGlob: path.join(ROOT, "tests/contracts/RequireToError.ts"),
      root,
    });
    expect(result.exitCode).toBe(2);

    const srcDir = path.join(root, "src");
    const emitted = fs.readdirSync(srcDir).map((f) => fs.readFileSync(path.join(srcDir, f), "utf8")).join("\n");

    // custom-errors rewrites require(cond, "msg") -- if the optimizer is skipped
    // here, the tested contract reverts differently than the deployed one.
    expect(emitted).toContain("error ");
    expect(emitted).toMatch(/revert \w+\(\);/);
    expect(emitted).not.toMatch(/require\(.*,\s*"/);

    fs.rmSync(root, { recursive: true, force: true });
  });
});

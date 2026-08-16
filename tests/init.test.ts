import { describe, it, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initCommand } from "../src/cli/init";

let scratch: string | undefined;

function scaffold(): string {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-init-"));
  return path.join(scratch, "proj");
}

afterEach(() => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe("init", () => {
  it("wires the contract DSL types into the scaffolded project", async () => {
    const dir = scaffold();
    await initCommand(dir);

    // Without this reference the ambient `declare module "scriipture"` never loads and
    // every DSL import (Address, msg, @storage) fails with TS2305.
    const env = fs.readFileSync(path.join(dir, "scriipture-env.d.ts"), "utf8");
    expect(env).toContain('/// <reference types="scriipture/types" />');

    const tsconfig = fs.readFileSync(path.join(dir, "tsconfig.json"), "utf8");
    expect(JSON.parse(tsconfig).include).toContain("scriipture-env.d.ts");
  });

  it("declares scriipture as a dependency of the scaffolded project", async () => {
    const dir = scaffold();
    await initCommand(dir);

    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    expect(pkg.devDependencies.scriipture).toMatch(/^(\^\d+\.\d+\.\d+|latest$)/);
  });
});

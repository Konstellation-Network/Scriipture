import fs from "node:fs";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import pc from "picocolors";
import { parseContractFiles } from "../parser/parse";
import { emitProgram } from "../emitter/emit";
import { optimizeProgram } from "../optimizer/passes";
import { collectTsFiles } from "../cli/parse";
import { foundrySolcLine, resolveOZRoot } from "../compiler/solc";
import { resolveTool } from "../runtime/tool-paths";

const FORGE_ROOT_DEFAULT = "out/forge";
const OZ_REL_NM = "@openzeppelin/=";

export interface ForgeRunInput {
  testsGlob: string;
  contractsGlob: string;
  pattern?: string;
  root?: string;
}

export interface ForgeRunResult {
  ok: boolean;
  exitCode: number;
}

export async function runForgeTests(input: ForgeRunInput): Promise<ForgeRunResult> {
  const root = path.resolve(input.root ?? FORGE_ROOT_DEFAULT);
  const srcDir = path.join(root, "src");
  const testDir = path.join(root, "test");
  const libDir = path.join(root, "lib");

  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(testDir, { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });

  const contractFiles = collectTsFiles(input.contractsGlob);
  if (contractFiles.length === 0) {
    console.error(pc.yellow(`no contracts at ${input.contractsGlob}`));
  } else {
    const { program } = parseContractFiles(contractFiles);
    // Contracts under test must match what `build` ships, so the optimizer runs
    // here too: passes like custom-errors change the revert path. Test harness
    // contracts below are deliberately left unoptimized -- they are never
    // deployed, and rewriting their requires would change assertion semantics.
    optimizeProgram(program);
    for (const emitted of emitProgram(program)) {
      fs.writeFileSync(path.join(srcDir, `${emitted.name}.sol`), emitted.solidity, "utf8");
    }
  }

  const testFiles = collectTsFiles(input.testsGlob);
  if (testFiles.length === 0) {
    console.error(pc.red(`no test files at ${input.testsGlob}`));
    return { ok: false, exitCode: 2 };
  }

  const { program: testProgram } = parseContractFiles(testFiles);
  for (const c of testProgram.contracts) {
    const refs = collectClassReferences(c);
    const localImports = Array.from(refs).filter((r) => r !== c.name && !KNOWN_BASES.has(r));
    let emitted = emitProgram({ contracts: [c] })[0]!.solidity;
    if (localImports.length > 0) {
      const importBlock = localImports.map((n) => `import "../src/${n}.sol";`).join("\n") + "\n";
      emitted = injectImports(emitted, importBlock);
    }
    fs.writeFileSync(path.join(testDir, `${c.name}.t.sol`), emitted, "utf8");
  }

  writeFoundryToml(root);
  writeRemappings(root);
  ensureForgeStd(libDir);

  const args = ["test", "--root", root];
  if (input.pattern) args.push("--match-test", input.pattern);
  console.log(pc.dim(`$ forge ${args.join(" ")}`));

  const forge = await resolveTool("forge");
  return await new Promise<ForgeRunResult>((resolve) => {
    const child = spawn(forge.cmd, [...forge.argPrefix, ...args], { stdio: "inherit" });
    child.on("exit", (code) => resolve({ ok: code === 0, exitCode: code ?? 1 }));
  });
}

const KNOWN_BASES = new Set(["ERC20", "ERC721", "Ownable", "ReentrancyGuard", "Test"]);

function collectClassReferences(contract: { name: string; functions: any[]; bases: string[] }): Set<string> {
  const refs = new Set<string>();
  for (const b of contract.bases) refs.add(b);
  for (const fn of contract.functions) walk(fn);
  refs.delete("address");
  return refs;

  function walk(node: any): void {
    if (!node || typeof node !== "object") return;
    if (node.kind === "new" && typeof node.className === "string") refs.add(node.className);
    if (Array.isArray(node)) {
      for (const it of node) walk(it);
      return;
    }
    for (const k of Object.keys(node)) walk(node[k]);
  }
}

function injectImports(sol: string, importBlock: string): string {
  const lines = sol.split("\n");
  let insertAt = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith("import ")) insertAt = i + 1;
    if (lines[i]!.startsWith("contract ")) break;
  }
  lines.splice(insertAt, 0, importBlock.trimEnd());
  return lines.join("\n");
}

function writeFoundryToml(root: string): void {
  // Pinned to what the sources written so far need (see toolSolcVersion).
  const sources = ["src", "test"].flatMap((d) => {
    const dir = path.join(root, d);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".sol")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")) : [];
  });
  const ozRoot = resolveOZRoot();
  const ozRemap = ozRoot ? `"@openzeppelin/contracts/=${ozRoot}/",` : "";
  const toml = `[profile.default]
src = "src"
test = "test"
out = "out"
libs = ["lib"]
${foundrySolcLine(sources)}optimizer = true
optimizer_runs = 200
remappings = [
  ${ozRemap}
  "forge-std/=lib/forge-std/src/"
]
`;
  fs.writeFileSync(path.join(root, "foundry.toml"), toml, "utf8");
}

function writeRemappings(root: string): void {
  const ozRoot = resolveOZRoot();
  const ozLine = ozRoot ? `@openzeppelin/contracts/=${ozRoot}/\n` : "";
  fs.writeFileSync(
    path.join(root, "remappings.txt"),
    `${ozLine}forge-std/=lib/forge-std/src/\n`,
    "utf8",
  );
}

function ensureForgeStd(libDir: string): void {
  const target = path.join(libDir, "forge-std");
  if (fs.existsSync(path.join(target, "src", "Test.sol"))) return;

  fs.mkdirSync(libDir, { recursive: true });
  const root = path.dirname(libDir);
  console.log(pc.dim("installing forge-std…"));
  const r = spawnSync("git", [
    "clone", "--depth", "1",
    "https://github.com/foundry-rs/forge-std",
    target,
  ], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error("failed to install forge-std (git clone returned nonzero)");
  }
}

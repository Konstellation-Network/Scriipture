/**
 * The CLI's command tree, with no side effects: `index.ts` parses argv with it,
 * and scripts/gen-cli-manifest.ts walks it to write docs/cli-commands.yaml.
 */
import { Command } from "commander";
import { parseCommand } from "./parse";
import { buildCommand } from "./build";
import { validateCommand } from "./validate";
import { optimizeCommand } from "./optimize";
import { compileCommand } from "./compile";
import { deployCommand } from "./deploy";
import { initCommand } from "./init";
import { gasdiffCommand } from "./gasdiff";
import { auditCommand } from "./audit";
import { auditPackCommand } from "./audit-pack";
import { traceCommand } from "./trace";
import { testCommand } from "./test";
import { verifyCommand } from "./verify";
import { secureDeployCommand } from "./secure-deploy";
import { walletNewCommand, walletShowCommand, walletListCommand, walletBalanceCommand } from "./wallet";
import { verifySourceCommand } from "./verify-source";
import { configSetCommand, configGetCommand, configListCommand, configUnsetCommand } from "./config-cmd";
import { doctorCommand } from "./doctor";
import { getScriiptureVersion } from "./version";
import { bannerText } from "./banner";

export const program = new Command();
program
  .name("scriipture")
  .description("Write smart contracts in TypeScript. Ship Solidity.")
  .version(getScriiptureVersion() ?? "0.0.0");

// Shown above the help screen — i.e. on `scriipture` with no args and on
// `--help`, the two moments someone is looking at the tool rather than using it.
// Suppressed for piped output and narrow terminals; see ./banner.
program.addHelpText("beforeAll", () => bannerText());

program
  .command("parse <input>")
  .description("Parse TypeScript contract(s) to IR JSON")
  .action(async (input: string) => {
    await parseCommand(input);
  });

program
  .command("build <input>")
  .description("Transpile TypeScript contract(s) to Solidity (optimizer applied by default)")
  .option("-o, --out <dir>", "output directory", "out/sol")
  .option("--no-optimize", "skip optimizer passes")
  .option("--reorder-storage", "let pack-slots reorder state variables to save slots (rewrites the storage layout; never use with upgradeable proxies)")
  .option("--no-validate", "emit even when the validator reports errors (the output may not match the source)")
  .action(async (input: string, opts: { out: string; optimize: boolean; reorderStorage?: boolean; validate: boolean }) => {
    await buildCommand(input, { out: opts.out, noOptimize: !opts.optimize, reorderStorage: opts.reorderStorage, noValidate: !opts.validate });
  });

program
  .command("validate <input>")
  .description("Run static checks on contract(s)")
  .option("--secure", "escalate footgun warnings to errors unless explicitly allowed")
  .action(async (input: string, opts: { secure?: boolean }) => {
    await validateCommand(input, opts);
  });

program
  .command("optimize <input>")
  .description("Report gas optimization suggestions")
  .action(async (input: string) => {
    await optimizeCommand(input);
  });

program
  .command("compile <input>")
  .description("Compile .sol files to ABI + bytecode artifacts")
  .option("-o, --out <dir>", "artifacts directory")
  .action(async (input: string, opts: { out?: string }) => {
    await compileCommand(input, opts);
  });

program
  .command("deploy <contract>")
  .description("Deploy a compiled artifact (auto-uses browser wallet when no --wallet given; auto-verifies if etherscan-key is configured)")
  .requiredOption("-n, --network <name>", "network: anvil | base-sepolia | base | sepolia | mainnet | optimism | optimism-sepolia | arbitrum | arbitrum-sepolia | polygon | polygon-amoy (or any configured)")
  .option("-a, --args <args...>", "constructor arguments", [])
  .option("-w, --wallet <name>", "use a named hot wallet from ~/.scriipture/wallets/ (otherwise browser-wallet)")
  .option("--no-browser", "force a hot wallet (requires --wallet) — disables browser fallback")
  .option("--no-verify", "skip auto-verify on Etherscan even when etherscan-key is configured")
  .action(async (contract: string, opts: { network: string; args: string[]; wallet?: string; browser: boolean; verify: boolean }) => {
    await deployCommand(contract, {
      network: opts.network,
      args: opts.args,
      wallet: opts.wallet,
      browser: opts.browser === false ? false : (opts.wallet ? false : undefined),
      verify: opts.verify === false ? false : undefined,
    });
  });

program
  .command("verify-source <contract>")
  .description("Submit source to Etherscan (v2 multichain) to verify an already-deployed contract")
  .requiredOption("-n, --network <name>", "network name")
  .option("--address <addr>", "deployed contract address (otherwise read from out/deploy-log)")
  .option("-a, --args <args...>", "constructor arguments used at deploy (otherwise read from log)")
  .option("--api-key <key>", "Etherscan API key (otherwise read ETHERSCAN_API_KEY env)")
  .action(async (contract: string, opts: { network: string; address?: string; args?: string[]; apiKey?: string }) => {
    await verifySourceCommand(contract, {
      network: opts.network,
      address: opts.address as any,
      args: opts.args,
      apiKey: opts.apiKey,
    });
  });

const cfg = program.command("config").description("Manage user-level config (~/.scriipture/config.json)");
cfg.command("set <key> <value>")
  .description("Set a config value (e.g. etherscan-key, default-network)")
  .action(configSetCommand);
cfg.command("get <key>")
  .description("Print a config value (sensitive keys masked)")
  .action(configGetCommand);
cfg.command("list")
  .description("List all config values (sensitive keys masked unless --reveal)")
  .option("--reveal-keys", "print sensitive values in full")
  .action(async (opts: { revealKeys?: boolean }) => configListCommand(opts));
cfg.command("unset <key>")
  .description("Remove a config value")
  .action(configUnsetCommand);

const wallet = program.command("wallet").description("Manage local hot wallets (~/.scriipture/wallets/)");
wallet.command("new <name>")
  .description("Generate a new EVM keypair stored at ~/.scriipture/wallets/<name>.json")
  .action(walletNewCommand);
wallet.command("show <name>")
  .description("Show wallet address (and private key with --reveal-key)")
  .option("--reveal-key", "also print the private key")
  .action(async (name: string, opts: { revealKey?: boolean }) => walletShowCommand(name, opts));
wallet.command("list")
  .description("List local wallets")
  .action(walletListCommand);
wallet.command("balance <name>")
  .description("Check the wallet balance on a network")
  .requiredOption("-n, --network <name>", "network name")
  .action(async (name: string, opts: { network: string }) => walletBalanceCommand(name, opts));

program
  .command("init [dir]")
  .description("Scaffold a new Scriipture project (contracts/, config, tsconfig, package.json scripts)")
  .action(async (dir: string = ".") => {
    await initCommand(dir);
  });

program
  .command("doctor")
  .description("Check environment; pass --fix to auto-install missing tools")
  .option("--fix", "download forge/anvil + pull slither/mythril Docker images to make scriipture fully self-contained")
  .action((opts: { fix?: boolean }) => doctorCommand(opts));

program
  .command("gasdiff <input>")
  .description("Compare bytecode size: unoptimized vs optimized")
  .action(async (input: string) => {
    await gasdiffCommand(input);
  });

program
  .command("audit <input>")
  .description("Run native rules + Slither static analysis")
  .option("--strict", "exit nonzero on any finding")
  .option("-o, --out <dir>", "where .sol artifacts live (default: out/sol)")
  .action(async (input: string, opts: { strict?: boolean; out?: string }) => {
    await auditCommand(input, opts);
  });

program
  .command("audit-pack <input>")
  .description("Emit per-contract audit pack (TS + Sol + sourcemap + notes + slither + zip)")
  .option("-o, --out <dir>", "audit output root (default: out/audit)")
  .option("--no-zip", "skip the .zip step; write the directory only")
  .action(async (input: string, opts: { out?: string; zip: boolean }) => {
    await auditPackCommand(input, { out: opts.out, noZip: !opts.zip });
  });

program
  .command("trace")
  .description("Rewrite forge/solc stack traces to use TS line refs")
  .option("-i, --input <file>", "trace text input file (otherwise reads stdin)")
  .option("--sourcemap-dir <dir>", "where to find <Contract>.sourcemap.json (default: out/sol)")
  .action(async (opts: { input?: string; sourcemapDir?: string }) => {
    await traceCommand(opts);
  });

program
  .command("test")
  .description("Transpile .t.ts tests to .t.sol and run forge")
  .option("-p, --pattern <pattern>", "forge --match-test pattern")
  .option("--tests <dir>", "test source dir (default: tests/contracts)")
  .option("--contracts <dir>", "contract source dir (default: examples)")
  .option("--root <dir>", "forge project root (default: out/forge)")
  .action(async (opts: { pattern?: string; tests?: string; contracts?: string; root?: string }) => {
    await testCommand(opts);
  });

program
  .command("verify <input>")
  .description("Run the 9-gate security verification pipeline")
  .option("--skip <gates>", "comma-separated gates to skip: fuzz, smt, slither, mythril, invariants, patterns, fuzz-run", "")
  .option("--fuzz-runs <n>", "forge fuzz iterations per method (default 1000)", (v) => parseInt(v, 10))
  .option("--deep", "enable Mythril symbolic execution (Gate 4, ~90s/contract)")
  .option("--mythril-timeout <s>", "Mythril execution timeout per contract in seconds", (v) => parseInt(v, 10))
  .option("--reorder-storage", "let pack-slots reorder state variables to save slots (rewrites the storage layout)")
  .action(async (input: string, opts: { skip: string; fuzzRuns?: number; deep?: boolean; mythrilTimeout?: number; reorderStorage?: boolean }) => {
    const skip = opts.skip ? opts.skip.split(",").map((s) => s.trim()) : [];
    const r = await verifyCommand(input, { skip, fuzzRuns: opts.fuzzRuns, deep: opts.deep, mythrilTimeout: opts.mythrilTimeout, reorderStorage: opts.reorderStorage });
    process.exit(r.ok ? 0 : 1);
  });

program
  .command("secure-deploy <input>")
  .description("Run verification gates THEN deploy (refuses on any gate failure)")
  .requiredOption("-c, --contract <name>", "contract name to deploy after verification")
  .requiredOption("-n, --network <name>", "network name")
  .option("-a, --args <args...>", "constructor arguments", [])
  .option("--artifacts <dir>", "artifacts directory")
  .option("--no-fuzz", "skip auto-generated fuzz harnesses")
  .option("--no-smt", "skip SMTChecker")
  .option("--no-slither", "skip Slither")
  .option("--no-invariants", "skip invariant tests")
  .option("--no-patterns", "skip pattern library check")
  .option("--deep", "also run Mythril symbolic execution (Gate 4, ~90s/contract)")
  .option("--skip <gates>", "comma-separated gates to skip: fuzz, smt, slither, mythril, invariants, patterns, fuzz-run", "")
  .option("--fuzz-runs <n>", "forge fuzz iterations per method (default 1000)", (v) => parseInt(v, 10))
  .option("--mythril-timeout <s>", "Mythril execution timeout per contract in seconds", (v) => parseInt(v, 10))
  .option("--allow-skipped-gates <justification>", "deploy even though gates were skipped; the reason is recorded on every skipped gate in the attestation")
  .action(async (input: string, opts: any) => {
    await secureDeployCommand(input, {
      network: opts.network, args: opts.args, artifacts: opts.artifacts, contract: opts.contract,
      noFuzz: !opts.fuzz, noSmt: !opts.smt, noSlither: !opts.slither,
      noInvariants: !opts.invariants, noPatterns: !opts.patterns,
      deep: opts.deep, allowSkippedGates: opts.allowSkippedGates,
      skip: opts.skip ? String(opts.skip).split(",").map((s: string) => s.trim()).filter(Boolean) : [],
      fuzzRuns: opts.fuzzRuns, mythrilTimeout: opts.mythrilTimeout,
    });
  });

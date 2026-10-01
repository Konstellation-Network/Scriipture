import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { getScriiptureVersion } from "./version";
import { printBanner } from "./banner";

const STARTER_CONTRACT = `import { storage, view, onlyOwner } from "scriipture";

/// A minimal owner-gated counter to confirm your toolchain works end-to-end.
export class Counter {
  @storage count: bigint = 0n;

  @onlyOwner
  increment(): void {
    this.count = this.count + 1n;
  }

  @onlyOwner
  decrement(): void {
    this.count = this.count - 1n;
  }

  @view
  current(): bigint {
    return this.count;
  }
}
`;

const STARTER_CONFIG = `/** @type {import("scriipture").Config} */
const config = {
  compiler: {
    version: "0.8.20",
    optimizer: { enabled: true, runs: 200 },
  },
  networks: {
    anvil: {
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
      privateKeyEnv: "ANVIL_PRIVATE_KEY",
    },
  },
  outDir: "out",
  plugins: [],
};

export default config;
`;

const STARTER_GITIGNORE = `node_modules/
out/
.env
.env.local
`;

// Pulls in the ambient `declare module "scriipture"` that types the contract DSL
// (Address, msg, block, @storage, @view, ...). Without it, "scriipture" resolves to
// the compiler's library API and every DSL import fails with TS2305.
const STARTER_ENV_DTS = `/// <reference types="scriipture/types" />
`;

const STARTER_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": false,
    "noEmit": true,
    "isolatedModules": true
  },
  "include": ["contracts/**/*.ts", "scriipture-env.d.ts"]
}
`;

const STARTER_PKG_SCRIPTS = {
  build: "scriipture build contracts",
  validate: "scriipture validate contracts",
  verify: "scriipture verify contracts --skip fuzz,invariants",
  compile: "scriipture compile out/sol",
  deploy: "scriipture deploy Counter -n base-sepolia",
};

/**
 * Dependency range for the scriipture package in a scaffolded project, pinned to
 * the CLI doing the scaffolding so the generated contract types match the compiler.
 * Falls back to "latest" — a hardcoded version would go stale, and `^0.0.0` is not
 * satisfiable by any real release.
 */
function scaffoldDependencyRange(): string {
  const version = getScriiptureVersion();
  return version ? `^${version}` : "latest";
}

export async function initCommand(dir: string): Promise<void> {
  printBanner();

  const absDir = path.resolve(dir);
  fs.mkdirSync(absDir, { recursive: true });
  fs.mkdirSync(path.join(absDir, "contracts"), { recursive: true });

  writeIfMissing(path.join(absDir, "contracts", "Counter.ts"), STARTER_CONTRACT);
  writeIfMissing(path.join(absDir, "scriipture.config.mjs"), STARTER_CONFIG);
  writeIfMissing(path.join(absDir, ".gitignore"), STARTER_GITIGNORE);
  writeIfMissing(path.join(absDir, "tsconfig.json"), STARTER_TSCONFIG);
  writeIfMissing(path.join(absDir, "scriipture-env.d.ts"), STARTER_ENV_DTS);

  const pkgPath = path.join(absDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    pkg.scripts = { ...(pkg.scripts ?? {}), ...STARTER_PKG_SCRIPTS };
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    console.log(pc.green(`updated ${pkgPath} — added scriipture scripts`));
  } else {
    const pkg = {
      name: path.basename(absDir),
      version: "0.0.1",
      type: "module",
      scripts: STARTER_PKG_SCRIPTS,
      devDependencies: {
        "@openzeppelin/contracts": "^5.0.0",
        scriipture: scaffoldDependencyRange(),
      },
    };
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    console.log(pc.green(`created ${pkgPath}`));
  }

  console.log("");
  console.log(pc.bold("Next steps:"));
  console.log(`  cd ${dir === "." ? "<this directory>" : dir}`);
  console.log("  npm install                          # or bun/yarn/pnpm");
  console.log("  npx scriipture doctor               # check environment");
  console.log("  npx scriipture build contracts      # transpile → out/sol/");
  console.log("  npx scriipture deploy Counter -n base-sepolia");
  console.log("");
  console.log(pc.dim("For full docs: https://github.com/Konstellation-Network/Scriipture/blob/main/docs/details.md"));
}

function writeIfMissing(p: string, content: string): void {
  if (fs.existsSync(p)) {
    console.log(pc.dim(`skipped ${p} (exists)`));
    return;
  }
  fs.writeFileSync(p, content);
  console.log(pc.green(`created ${p}`));
}

import pc from "picocolors";
import { createPublicClient, http, formatEther } from "viem";
import { createWallet, listWallets, loadWallet, walletPath } from "../wallet/store";
import { resolveChain } from "../deploy/networks";

export async function walletNewCommand(name: string): Promise<void> {
  try {
    const w = createWallet(name);
    console.log(pc.green(`✓ created wallet "${name}"`));
    console.log("");
    console.log(pc.bold("  address:     ") + pc.cyan(w.address));
    console.log(pc.bold("  stored at:   ") + walletPath(name) + pc.dim("  (mode 0600)"));
    console.log("");
    console.log(pc.yellow("⚠  This is a hot wallet stored in plain JSON on disk."));
    console.log(pc.yellow("   Anyone with shell access to this Mac can drain it."));
    console.log(pc.yellow("   Use only for testnets or small-value tests."));
    console.log("");
    console.log(pc.dim("  reveal private key:   scriipture wallet show ") + pc.dim(name) + pc.dim(" --reveal-key"));
    console.log(pc.dim("  check balance:        scriipture wallet balance ") + pc.dim(name) + pc.dim(" --network base-sepolia"));
  } catch (err: any) {
    console.error(pc.red(`✗ ${err.message}`));
    process.exit(1);
  }
}

export async function walletShowCommand(name: string, opts: { revealKey?: boolean }): Promise<void> {
  try {
    const w = loadWallet(name);
    console.log(pc.bold("name:    ") + w.name);
    console.log(pc.bold("address: ") + pc.cyan(w.address));
    console.log(pc.bold("created: ") + w.createdAt);
    if (opts.revealKey) {
      console.log("");
      console.log(pc.red("PRIVATE KEY (do not share, do not paste anywhere unsafe):"));
      console.log(pc.red(w.privateKey));
    } else {
      console.log("");
      console.log(pc.dim("(use --reveal-key to print the private key)"));
    }
  } catch (err: any) {
    console.error(pc.red(`✗ ${err.message}`));
    process.exit(1);
  }
}

export async function walletListCommand(): Promise<void> {
  const wallets = listWallets();
  if (wallets.length === 0) {
    console.log(pc.dim("no wallets yet — scriipture wallet new <name>"));
    return;
  }
  for (const w of wallets) {
    console.log(`  ${pc.bold(w.name.padEnd(20))} ${pc.cyan(w.address)}  ${pc.dim(w.createdAt)}`);
  }
}

export async function walletBalanceCommand(name: string, opts: { network: string }): Promise<void> {
  const w = loadWallet(name);
  const chain = resolveChain(opts.network) as any;
  const rpc = chain?.rpcUrls?.default?.http?.[0];
  if (!rpc) {
    console.error(pc.red(`no RPC URL for network "${opts.network}"`));
    process.exit(1);
  }
  const client = createPublicClient({ chain, transport: http(rpc) });
  const bal = await client.getBalance({ address: w.address });
  console.log(pc.bold("wallet:  ") + name);
  console.log(pc.bold("address: ") + pc.cyan(w.address));
  console.log(pc.bold("network: ") + opts.network + pc.dim(`  (chain id ${chain.id})`));
  console.log(pc.bold("balance: ") + formatEther(bal) + " ETH" + pc.dim(`  (${bal.toString()} wei)`));
}

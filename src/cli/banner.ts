import pc from "picocolors";

const ART = [
  "███████╗ ██████╗██████╗ ██╗██╗██████╗ ████████╗██╗   ██╗██████╗ ███████╗",
  "██╔════╝██╔════╝██╔══██╗██║██║██╔══██╗╚══██╔══╝██║   ██║██╔══██╗██╔════╝",
  "███████╗██║     ██████╔╝██║██║██████╔╝   ██║   ██║   ██║██████╔╝█████╗  ",
  "╚════██║██║     ██╔══██╗██║██║██╔═══╝    ██║   ██║   ██║██╔══██╗██╔══╝  ",
  "███████║╚██████╗██║  ██║██║██║██║        ██║   ╚██████╔╝██║  ██║███████╗",
  "╚══════╝ ╚═════╝╚═╝  ╚═╝╚═╝╚═╝╚═╝        ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚══════╝",
];

const ART_WIDTH = 72;

/**
 * The wordmark, as a string. Empty when it would be unwelcome — piped output,
 * a terminal too narrow to hold it, or an explicit opt-out.
 *
 * Returned rather than printed so callers can place it (commander's help hooks
 * take a string, and `init` appends it after its own output).
 */
export function bannerText(): string {
  if (process.env.SCRIIPTURE_NO_BANNER) return "";

  // Art in redirected stdout corrupts machine-readable output and litters logs.
  if (!process.stdout.isTTY) return "";

  // A pty that can't report its size gives 0 (or undefined) — that means
  // "unknown", not "zero columns wide". Only treat a positive, genuinely small
  // width as too narrow, or the art vanishes in CI and some terminals.
  const columns = process.stdout.columns;
  if (typeof columns === "number" && columns > 0 && columns < ART_WIDTH) {
    // Block letters wrapped mid-glyph read as garbage; degrade to the wordmark.
    return `\n${pc.bold("SCRIIPTURE")}\n`;
  }

  // Bold on the terminal's own foreground rather than an explicit white: bright
  // white is near-invisible on light-background terminals, which is exactly
  // where a wordmark can least afford to disappear.
  return `\n${ART.map((line) => pc.bold(line)).join("\n")}\n`;
}

export function printBanner(): void {
  const text = bannerText();
  if (text) console.log(text);
}

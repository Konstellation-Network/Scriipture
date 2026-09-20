import { describe, it, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileSolidity, isSmtDiagnostic, smtSeverity, smtKind, isSolverUnavailable, nativeSolc, probeModelChecker } from "../src/compiler/solc";
import { ConfigSchema } from "../src/config/schema";

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "tests/contracts/fixtures-smt.sol");

const ORIGINAL_PATH = process.env.PATH;
afterEach(() => { process.env.PATH = ORIGINAL_PATH; });

/** A stand-in for a native solc that answers --standard-json with canned output. */
function withFakeSolc(stdout: string, exitCode: number, fn: () => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-fakesolc-"));
  fs.writeFileSync(
    path.join(dir, "solc"),
    `#!/bin/sh\n` +
      `if [ "$1" = "--version" ]; then echo "solc, the solidity compiler commandline interface"; echo "Version: 0.8.37+commit.fake"; exit 0; fi\n` +
      `cat > /dev/null\n` +
      `cat <<'SOLCJSON'\n${stdout}\nSOLCJSON\n` +
      `exit ${exitCode}\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${dir}${path.delimiter}${ORIGINAL_PATH}`;
  try { fn(); } finally { process.env.PATH = ORIGINAL_PATH; }
}

function run() {
  return compileSolidity({ solFiles: [SOURCE], config: ConfigSchema.parse({}), modelCheck: true });
}

// Real solc output shapes, taken from what CHC/BMC actually emit.
const VIOLATION = JSON.stringify({
  errors: [{
    component: "general", errorCode: "6328", severity: "warning", type: "Warning",
    message: "CHC: Assertion violation happens here.\nCounterexample:\ntotal = 1",
    formattedMessage: "Warning: CHC: Assertion violation happens here.\n --> fixtures-smt.sol:8:9:",
    sourceLocation: { file: "fixtures-smt.sol", start: 120, end: 150 },
  }],
});
const UNPROVED = JSON.stringify({
  errors: [{
    errorCode: "4984", severity: "warning", type: "Warning",
    message: "BMC: Overflow (resulting value larger than 2**256 - 1) might happen here.",
    sourceLocation: { file: "fixtures-smt.sol", start: 120, end: 150 },
  }],
});
const NO_HORN_SOLVER = JSON.stringify({
  errors: [
    { errorCode: "8158", severity: "warning", type: "Warning", message: "Solver z3 was selected for SMTChecker but it is not available." },
    { errorCode: "7649", severity: "warning", type: "Warning", message: "CHC analysis was not possible since no Horn solver was found and enabled." },
  ],
});

describe("SMTChecker message classification", () => {
  it("recognises CHC and BMC findings, and nothing else", () => {
    expect(isSmtDiagnostic({ message: "CHC: Assertion violation happens here." })).toBe(true);
    expect(isSmtDiagnostic({ message: "BMC: Underflow might happen here." })).toBe(true);
    expect(isSmtDiagnostic({ message: "Warning: Unused local variable." })).toBe(false);
  });

  it("separates an assertion violation from an arithmetic one", () => {
    expect(smtKind("CHC: Assertion violation happens here.")).toBe("assertion");
    expect(smtKind("BMC: Overflow (resulting value larger than 2**256 - 1) happens here.")).toBe("arithmetic");
    expect(smtKind("CHC: Division by zero happens here.")).toBe("arithmetic");
    expect(smtKind("CHC: 3 verification condition(s) proved safe!")).toBe("other");
  });

  it("reads the verdict from the message, not from solc's severity", () => {
    // Every SMTChecker finding arrives as a warning or an info, never an error.
    expect(smtSeverity("CHC: Assertion violation happens here.")).toBe("error");
    expect(smtSeverity("CHC: Assertion violation might happen here.")).toBe("warning");
    expect(smtSeverity("BMC: Overflow ... might happen here.")).toBe("warning");
    expect(smtSeverity("CHC: 3 verification condition(s) proved safe!")).toBe("info");
  });

  it("recognises every way solc says the model checker could not run", () => {
    expect(isSolverUnavailable({ errorCode: "7649", message: "CHC analysis was not possible since no Horn solver was found and enabled." })).toBe(true);
    expect(isSolverUnavailable({ errorCode: "8158", message: "Solver z3 was selected for SMTChecker but it is not available." })).toBe(true);
    expect(isSolverUnavailable({ message: "CHC analysis was not possible since no Horn solver was found and enabled." })).toBe(true);
    expect(isSolverUnavailable({ type: "Exception", message: "Unknown exception during compilation: thread constructor failed" })).toBe(true);
    expect(isSolverUnavailable({ errorCode: "6328", message: "CHC: Assertion violation happens here." })).toBe(false);
  });
});

describe("SMTChecker capture through a native solc", () => {
  it("captures an assertion violation as an error even though solc calls it a warning", () => {
    withFakeSolc(VIOLATION, 0, () => {
      const r = run();
      expect(r.modelChecker?.ran).toBe(true);
      expect(r.modelChecker?.engine).toBe("native-solc");
      expect(r.modelChecker?.version).toContain("0.8.37");
      expect(r.smtFindings).toHaveLength(1);
      expect(r.smtFindings[0]!.severity).toBe("error");
      expect(r.smtFindings[0]!.kind).toBe("assertion");
      expect(r.smtFindings[0]!.errorCode).toBe("6328");
      expect(r.smtFindings[0]!.file).toBe("fixtures-smt.sol");
      expect(r.warnings).toEqual([]); // it must not be filed away as an ordinary warning
    });
  });

  it("captures an unproved property as a warning", () => {
    withFakeSolc(UNPROVED, 0, () => {
      const r = run();
      expect(r.smtFindings.map((f) => f.severity)).toEqual(["warning"]);
      expect(r.smtFindings[0]!.kind).toBe("arithmetic");
      expect(r.smtFindings[0]!.errorCode).toBe("4984");
    });
  });

  it("records a solc with no Horn solver as never having run", () => {
    withFakeSolc(NO_HORN_SOLVER, 0, () => {
      const r = run();
      expect(r.modelChecker?.ran).toBe(false);
      expect(r.modelChecker?.reason).toMatch(/Horn solver|not available/);
      expect(r.modelChecker?.version).toContain("0.8.37");
      expect(r.smtFindings).toEqual([]);
      expect(r.errors).toEqual([]); // the compile itself was fine
    });
  });

  it("records a crashed solc as never having run rather than as a clean run", () => {
    withFakeSolc("", 139, () => {
      const r = run();
      expect(r.modelChecker?.ran).toBe(false);
      expect(r.modelChecker?.reason).toMatch(/exited 139/);
    });
  });

  it("records a solc that prints no JSON as never having run", () => {
    withFakeSolc("not json at all", 0, () => {
      const r = run();
      expect(r.modelChecker?.ran).toBe(false);
      expect(r.modelChecker?.reason).toMatch(/no JSON/);
    });
  });

  it("falls back to solc-js when no native solc is on PATH, and admits it cannot run Z3", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriipture-nosolc-"));
    process.env.PATH = dir;
    expect(nativeSolc()).toBeNull();
    const r = run();
    expect(r.modelChecker?.ran).toBe(false);
  }, 60_000);
});

describe("doctor's model-checker probe", () => {
  it("reports a working solver as ran", () => {
    // A solver that returns "nothing to report" for the probe contract is working.
    withFakeSolc(JSON.stringify({ errors: [] }), 0, () => {
      const status = probeModelChecker(ConfigSchema.parse({}));
      expect(status.ran).toBe(true);
      expect(status.engine).toBe("native-solc");
    });
  });

  it("reports a solver-less build as not ran, with the reason", () => {
    withFakeSolc(NO_HORN_SOLVER, 0, () => {
      const status = probeModelChecker(ConfigSchema.parse({}));
      expect(status.ran).toBe(false);
      expect(status.reason).toMatch(/Horn solver|not available/);
    });
  });
});

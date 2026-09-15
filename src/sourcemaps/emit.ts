import type { IRContract } from "../ir/types";

export interface SourceMapEntry {
  solLine: number;
  tsLine: number;
  symbol?: string;
}

export interface SourceMap {
  tsFile: string;
  solFile: string;
  entries: SourceMapEntry[];
}

export function buildSourceMap(contract: IRContract, solidity: string): SourceMap {
  const lines = solidity.split("\n");
  const entries: SourceMapEntry[] = [];

  const seek = (predicate: (line: string) => boolean): number => {
    for (let i = 0; i < lines.length; i++) if (predicate(lines[i]!)) return i + 1;
    return 0;
  };

  if (contract.loc) {
    const headerLine = seek((ln) => new RegExp(`\\bcontract\\s+${contract.name}\\b`).test(ln));
    if (headerLine) entries.push({ solLine: headerLine, tsLine: contract.loc.line, symbol: contract.name });
  }

  for (const v of contract.stateVars) {
    if (!v.loc) continue;
    const ln = seek((line) =>
      new RegExp(`\\b${escape(v.name)}\\b`).test(line) &&
      /(public|private|internal|constant|immutable|mapping)/.test(line),
    );
    if (ln) entries.push({ solLine: ln, tsLine: v.loc.line, symbol: v.name });
  }

  for (const fn of contract.functions) {
    if (!fn.loc) continue;
    const needle = fn.isConstructor
      ? /constructor\s*\(/
      : new RegExp(`function\\s+${escape(fn.name)}\\s*\\(`);
    const ln = seek((line) => needle.test(line));
    if (ln) entries.push({ solLine: ln, tsLine: fn.loc.line, symbol: fn.name });
  }

  for (const st of contract.structs) {
    const ln = seek((line) => new RegExp(`\\bstruct\\s+${escape(st.name)}\\b`).test(line));
    if (ln) entries.push({ solLine: ln, tsLine: st.loc?.line ?? contract.loc?.line ?? 1, symbol: st.name });
  }

  for (const en of contract.enums) {
    const ln = seek((line) => new RegExp(`\\benum\\s+${escape(en.name)}\\b`).test(line));
    if (ln) entries.push({ solLine: ln, tsLine: en.loc?.line ?? contract.loc?.line ?? 1, symbol: en.name });
  }

  for (const err of contract.errors) {
    const ln = seek((line) => new RegExp(`\\berror\\s+${escape(err.name)}\\s*\\(`).test(line));
    if (ln) entries.push({ solLine: ln, tsLine: contract.loc?.line ?? 1, symbol: err.name });
  }

  entries.sort((a, b) => a.solLine - b.solLine);

  return {
    tsFile: contract.sourceFile,
    solFile: `${contract.name}.sol`,
    entries,
  };
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

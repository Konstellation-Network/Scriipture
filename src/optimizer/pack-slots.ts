import type { IRContract, IRStateVar, IRType } from "../ir/types";
import type { OptimizationChange, OptimizeOptions } from "./passes";

const SLOT_SIZE_BITS = 256;

/**
 * Bits a state variable occupies inside a storage slot, or a full slot when
 * it cannot share one (dynamic types, mappings, arrays, unknown custom types).
 */
export function storageBitSize(type: IRType): number {
  switch (type.kind) {
    case "mapping":
    case "array":
    case "tuple": // never a state variable's type; a full slot keeps the switch total
      return SLOT_SIZE_BITS;
    case "primitive": {
      if (type.name === "bool") return 8;
      if (type.name === "address") return 160;
      const int = /^u?int(\d+)$/.exec(type.name);
      if (int) return Number(int[1]);
      const bytes = /^bytes(\d+)$/.exec(type.name);
      if (bytes) return Number(bytes[1]) * 8;
      return SLOT_SIZE_BITS; // dynamic string/bytes
    }
    case "enum":
      return 8; // solc stores enums as uint8 (up to 256 members)
    case "struct":
      return SLOT_SIZE_BITS; // structs start a fresh slot and take at least one
    case "custom":
      return customTypeBits(type.name);
  }
}

function customTypeBits(name: string): number {
  if (name === "Address" || name === "CheckedAddress") return 160;
  // Forward-compatible with narrow integer / fixed bytes aliases (Uint8, Int128, Bytes4, uint32, …).
  const int = /^(u?int)(\d+)$/i.exec(name);
  if (int) {
    const bits = Number(int[2]);
    if (bits >= 8 && bits <= 256 && bits % 8 === 0) return bits;
  }
  const bytes = /^bytes(\d+)$/i.exec(name);
  if (bytes) {
    const n = Number(bytes[1]);
    if (n >= 1 && n <= 32) return n * 8;
  }
  return SLOT_SIZE_BITS;
}

/** Constants and immutables live in bytecode, not storage; they never occupy a slot. */
export function occupiesStorage(v: IRStateVar): boolean {
  return v.mutability === undefined;
}

/**
 * Number of storage slots solc allocates for the given declaration order.
 * solc already packs adjacent small variables into one slot, so this is the
 * real baseline any reordering has to beat.
 */
export function countStorageSlots(vars: IRStateVar[]): number {
  let slots = 0;
  let used = SLOT_SIZE_BITS;
  for (const v of vars) {
    if (!occupiesStorage(v)) continue;
    const bits = storageBitSize(v.type);
    if (used + bits > SLOT_SIZE_BITS) {
      slots += 1;
      used = bits;
    } else {
      used += bits;
    }
  }
  return slots;
}

export interface PackedLayout {
  /** Storage-occupying variables in an order that minimises slots (first-fit decreasing). */
  order: IRStateVar[];
  slotsBefore: number;
  slotsAfter: number;
}

export function computePackedLayout(vars: IRStateVar[]): PackedLayout {
  const storageVars = vars.filter(occupiesStorage);
  const small = storageVars.filter((v) => storageBitSize(v.type) < SLOT_SIZE_BITS);
  const full = storageVars.filter((v) => storageBitSize(v.type) >= SLOT_SIZE_BITS);

  // First-fit decreasing: stable sort by size, place each var in the first bin it fits.
  const bins: Array<{ used: number; vars: IRStateVar[] }> = [];
  const sorted = small
    .map((v, i) => ({ v, i, bits: storageBitSize(v.type) }))
    .sort((a, b) => b.bits - a.bits || a.i - b.i);
  for (const { v, bits } of sorted) {
    const bin = bins.find((b) => b.used + bits <= SLOT_SIZE_BITS);
    if (bin) {
      bin.used += bits;
      bin.vars.push(v);
    } else {
      bins.push({ used: bits, vars: [v] });
    }
  }

  const order = [...bins.flatMap((b) => b.vars), ...full];
  return { order, slotsBefore: countStorageSlots(storageVars), slotsAfter: bins.length + full.length };
}

/**
 * Storage slot packing.
 *
 * Advisory by default: it reports how many slots a reordering would save but
 * leaves `contract.stateVars` untouched, because reordering state variables
 * rewrites the contract's storage layout — which breaks upgradeable proxies
 * and is exactly what the downstream layout checks exist to flag.
 *
 * Pass `{ reorderStorage: true }` to apply the reordering.
 */
export function packSlots(contract: IRContract, options: OptimizeOptions = {}): OptimizationChange[] {
  const changes: OptimizationChange[] = [];
  const vars = contract.stateVars;
  if (vars.length < 2) return changes;

  const layout = computePackedLayout(vars);
  if (layout.slotsAfter >= layout.slotsBefore) return changes;

  const suggested = layout.order.map((v) => v.name).join(", ");
  if (options.reorderStorage) {
    const nonStorage = vars.filter((v) => !occupiesStorage(v));
    contract.stateVars = [...nonStorage, ...layout.order];
    changes.push({
      pass: "pack-slots",
      detail: `reordered state vars to use ${layout.slotsAfter} storage slot(s) (was ${layout.slotsBefore}); new order: ${suggested}. Storage layout changed — do not use with upgradeable proxies.`,
      applied: true,
    });
  } else {
    changes.push({
      pass: "pack-slots",
      detail: `state vars could pack into ${layout.slotsAfter} storage slot(s) (currently ${layout.slotsBefore}) by declaring them in this order: ${suggested}. Not applied — reordering changes the storage layout; pass --reorder-storage to apply.`,
      applied: false,
    });
  }
  return changes;
}

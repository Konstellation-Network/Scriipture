import type { IRPrimitiveName, IRType } from "../ir/types";

const CUSTOM_TYPE_ALIASES: Record<string, IRPrimitiveName> = {
  CheckedAddress: "address",
  Address: "address",
  Bytes32: "bytes32",
  Bytes: "bytes",
};

/**
 * The primitive a custom type name stands for (`CheckedAddress` → `address`),
 * or undefined for a name the emitter passes through verbatim. `solidityType`
 * already emits aliases this way; anything that reasons about a value's type
 * -- an emptiness test for `??` -- must see the same primitive.
 */
export function aliasedPrimitive(name: string): IRType | undefined {
  const primitive = CUSTOM_TYPE_ALIASES[name];
  return primitive ? { kind: "primitive", name: primitive } : undefined;
}

export function solidityType(type: IRType, location: "storage" | "memory" | "calldata" = "storage"): string {
  switch (type.kind) {
    case "primitive": {
      // Reference types carry their data location outside storage; "calldata"
      // is what the calldata-params pass asks for and must survive to the output.
      if ((type.name === "string" || type.name === "bytes") && location !== "storage") return `${type.name} ${location}`;
      return type.name;
    }
    case "mapping":
      return `mapping(${solidityType(type.key)} => ${solidityType(type.value)})`;
    case "array": {
      const base = `${solidityType(type.element)}[${type.length ?? ""}]`;
      if (location !== "storage") return `${base} ${location}`;
      return base;
    }
    case "struct":
      // Structs are reference types: outside storage they need a data location.
      return location === "storage" ? type.name : `${type.name} ${location}`;
    case "enum":
      return type.name;
    case "tuple":
      // Only meaningful in a `returns (…)` list or a tuple declaration; each part takes the location.
      return type.elements.map((t) => solidityType(t, location)).join(", ");
    case "function": {
      // A value type: no data location, whatever the slot asks for.
      const params = type.params.map((t) => solidityType(t, "memory")).join(", ");
      const mut = type.mutability ? ` ${type.mutability}` : "";
      const rets = type.returns.length > 0 ? ` returns (${type.returns.map((t) => solidityType(t, "memory")).join(", ")})` : "";
      return `function (${params}) ${type.visibility}${mut}${rets}`;
    }
    case "custom":
      return CUSTOM_TYPE_ALIASES[type.name] ?? type.name;
  }
}

/** Structural equality of two types, looking through `Address` / `CheckedAddress` / `Bytes32` aliases. */
export function sameType(a: IRType | undefined, b: IRType | undefined): boolean {
  if (!a || !b) return false;
  const norm = (t: IRType): IRType => (t.kind === "custom" ? aliasedPrimitive(t.name) ?? t : t);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

export function isValueType(type: IRType): boolean {
  if (type.kind === "enum" || type.kind === "function") return true;
  if (type.kind !== "primitive") return false;
  return type.name !== "string" && type.name !== "bytes" && type.name !== "void";
}

export function needsLocationQualifier(type: IRType): boolean {
  if (type.kind === "array") return true;
  if (type.kind === "mapping") return true;
  if (type.kind === "struct") return true;
  if (type.kind === "primitive" && (type.name === "string" || type.name === "bytes")) return true;
  return false;
}

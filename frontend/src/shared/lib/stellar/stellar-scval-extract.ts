import { xdr } from "@stellar/stellar-sdk";

function findMapValue(scVal: xdr.ScVal, fieldName?: string): xdr.ScVal | null {
  if (!fieldName) {
    return scVal;
  }

  if (scVal.switch().name !== "scvMap") {
    return null;
  }

  const map = scVal.map();
  if (!map) {
    return null;
  }

  for (const entry of map) {
    const key = entry.key();
    if (
      key.switch().name === "scvSymbol" &&
      key.sym().toString() === fieldName
    ) {
      return entry.val();
    }
  }

  return null;
}

export function extractU32FromScVal(
  scVal: xdr.ScVal,
  fieldName?: string,
): number | null {
  try {
    const value = findMapValue(scVal, fieldName);
    if (value?.switch().name === "scvU32") {
      return value.u32();
    }
    return null;
  } catch {
    return null;
  }
}

export function extractI128FromScVal(
  scVal: xdr.ScVal,
  fieldName?: string,
): bigint | null {
  try {
    const value = findMapValue(scVal, fieldName);
    if (value?.switch().name === "scvI128") {
      const i128Parts = value.i128();
      const hi = i128Parts.hi().toBigInt();
      const lo = i128Parts.lo().toBigInt();
      return (hi << 64n) | lo;
    }
    return null;
  } catch {
    return null;
  }
}

export function extractBoolFromScVal(
  scVal: xdr.ScVal,
  fieldName?: string,
): boolean | null {
  try {
    const value = findMapValue(scVal, fieldName);
    if (value?.switch().name === "scvBool") {
      return value.b();
    }
    return null;
  } catch {
    return null;
  }
}

export function stroopsToDisplayAmount(value: bigint): number {
  return Number(value) / 10_000_000;
}

import { xdr } from "@stellar/stellar-sdk";

export function extractU32FromScVal(
  scVal: xdr.ScVal,
  fieldName?: string,
): number | null {
  try {
    if (fieldName && scVal.switch().name === "scvMap") {
      const map = scVal.map();
      if (!map) return null;

      for (const entry of map) {
        const key = entry.key();
        if (
          key.switch().name === "scvSymbol" &&
          key.sym().toString() === fieldName
        ) {
          const val = entry.val();
          if (val.switch().name === "scvU32") {
            return val.u32();
          }
        }
      }
      return null;
    }

    if (scVal.switch().name === "scvU32") {
      return scVal.u32();
    }
    return null;
  } catch {
    return null;
  }
}

export function extractI128FromScVal(
  scVal: xdr.ScVal,
  fieldName?: string,
): number | null {
  try {
    if (fieldName && scVal.switch().name === "scvMap") {
      const map = scVal.map();
      if (!map) return null;

      for (const entry of map) {
        const key = entry.key();
        if (
          key.switch().name === "scvSymbol" &&
          key.sym().toString() === fieldName
        ) {
          const val = entry.val();
          if (val.switch().name === "scvI128") {
            const i128Parts = val.i128();
            const hi = i128Parts.hi().toBigInt();
            const lo = i128Parts.lo().toBigInt();
            const value = (hi << 64n) | lo;
            return Number(value) / 10_000_000;
          }
        }
      }
      return null;
    }

    if (scVal.switch().name === "scvI128") {
      const i128Parts = scVal.i128();
      const hi = i128Parts.hi().toBigInt();
      const lo = i128Parts.lo().toBigInt();
      const value = (hi << 64n) | lo;
      return Number(value) / 10_000_000;
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
    if (fieldName && scVal.switch().name === "scvMap") {
      const map = scVal.map();
      if (!map) return null;

      for (const entry of map) {
        const key = entry.key();
        if (
          key.switch().name === "scvSymbol" &&
          key.sym().toString() === fieldName
        ) {
          const val = entry.val();
          if (val.switch().name === "scvBool") {
            return val.b();
          }
        }
      }
      return null;
    }

    if (scVal.switch().name === "scvBool") {
      return scVal.b();
    }
    return null;
  } catch {
    return null;
  }
}

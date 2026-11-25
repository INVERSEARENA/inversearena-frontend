/**
 * Argument encoding: command-line strings -> the native values the contract
 * spec converts to ScVals. The spec (read from the contract's WASM) is the
 * source of truth for every type, so a wrong argument fails here with a
 * readable message instead of as an opaque host error after simulation.
 */
import { StrKey, contract, xdr } from "@stellar/stellar-sdk";

export class ArgumentError extends Error {
  override name = "ArgumentError";
}

const INT_RANGES: Record<string, [bigint, bigint]> = {
  u32: [0n, 2n ** 32n - 1n],
  i32: [-(2n ** 31n), 2n ** 31n - 1n],
  u64: [0n, 2n ** 64n - 1n],
  i64: [-(2n ** 63n), 2n ** 63n - 1n],
  u128: [0n, 2n ** 128n - 1n],
  i128: [-(2n ** 127n), 2n ** 127n - 1n],
  u256: [0n, 2n ** 256n - 1n],
  i256: [-(2n ** 255n), 2n ** 255n - 1n],
};

function integer(raw: string, kind: string, label: string): bigint {
  const cleaned = raw.replace(/_/g, "");
  if (!/^-?\d+$/.test(cleaned)) throw new ArgumentError(`${label}: expected an integer (${kind}), got "${raw}"`);
  const value = BigInt(cleaned);
  const [min, max] = INT_RANGES[kind]!;
  if (value < min || value > max) throw new ArgumentError(`${label}: ${raw} is out of range for ${kind}`);
  return value;
}

function hexBytes(raw: string, label: string, length?: number): Buffer {
  const hex = raw.replace(/^0x/i, "");
  if (!/^([0-9a-f]{2})*$/i.test(hex)) throw new ArgumentError(`${label}: expected hex bytes, got "${raw}"`);
  const bytes = Buffer.from(hex, "hex");
  if (length !== undefined && bytes.length !== length) {
    throw new ArgumentError(`${label}: expected ${length} bytes, got ${bytes.length}`);
  }
  return bytes;
}

function json(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ArgumentError(`${label}: expected JSON, got "${raw}"`);
  }
}

/** Convert one command-line string to the native value `spec` expects for `type`. */
export function coerceArg(spec: contract.Spec, type: xdr.ScSpecTypeDef, raw: string, label: string): unknown {
  const T = xdr.ScSpecType;
  switch (type.switch().value) {
    case T.scSpecTypeBool().value:
      if (raw !== "true" && raw !== "false") throw new ArgumentError(`${label}: expected true or false, got "${raw}"`);
      return raw === "true";
    case T.scSpecTypeU32().value:
      return Number(integer(raw, "u32", label));
    case T.scSpecTypeI32().value:
      return Number(integer(raw, "i32", label));
    case T.scSpecTypeU64().value:
      return integer(raw, "u64", label);
    case T.scSpecTypeI64().value:
      return integer(raw, "i64", label);
    case T.scSpecTypeU128().value:
      return integer(raw, "u128", label);
    case T.scSpecTypeI128().value:
      return integer(raw, "i128", label);
    case T.scSpecTypeU256().value:
      return integer(raw, "u256", label);
    case T.scSpecTypeI256().value:
      return integer(raw, "i256", label);
    case T.scSpecTypeAddress().value:
      if (!StrKey.isValidEd25519PublicKey(raw) && !StrKey.isValidContract(raw)) {
        throw new ArgumentError(`${label}: expected a G... account or C... contract address, got "${raw}"`);
      }
      return raw;
    case T.scSpecTypeSymbol().value:
      if (!/^[A-Za-z0-9_]{1,32}$/.test(raw)) throw new ArgumentError(`${label}: a symbol is 1-32 of [A-Za-z0-9_]`);
      return raw;
    case T.scSpecTypeString().value:
      return raw;
    case T.scSpecTypeBytes().value:
      return hexBytes(raw, label);
    case T.scSpecTypeBytesN().value:
      return hexBytes(raw, label, type.bytesN().n());
    case T.scSpecTypeOption().value:
      return raw === "" || raw === "none" ? null : coerceArg(spec, type.option().valueType(), raw, label);
    case T.scSpecTypeUdt().value:
      return coerceUdt(spec, type.udt().name().toString(), raw, label);
    default:
      // vec, map, tuple, …: JSON, converted element-wise by the spec.
      return json(raw, label);
  }
}

function coerceUdt(spec: contract.Spec, name: string, raw: string, label: string): unknown {
  const entry = spec.findEntry(name);
  const kind = entry.switch().value;
  const E = xdr.ScSpecEntryKind;
  if (kind === E.scSpecEntryUdtEnumV0().value) {
    const cases = entry.udtEnumV0().cases();
    const byName = cases.find((c) => c.name().toString() === raw);
    if (byName) return byName.value();
    if (/^\d+$/.test(raw) && cases.some((c) => c.value() === Number(raw))) return Number(raw);
    throw new ArgumentError(`${label}: expected one of ${cases.map((c) => c.name().toString()).join(", ")}`);
  }
  if (kind === E.scSpecEntryUdtUnionV0().value && /^[A-Za-z_]\w*$/.test(raw)) {
    const tags = entry.udtUnionV0().cases().map((c) => (c.switch().value === 0 ? c.voidCase() : c.tupleCase()).name().toString());
    if (!tags.includes(raw)) throw new ArgumentError(`${label}: expected one of ${tags.join(", ")}`);
    return { tag: raw, values: undefined };
  }
  return json(raw, label);
}

/** Encode positional command-line arguments for `method` in spec order. */
export function encodeArgs(spec: contract.Spec, method: string, rawArgs: readonly string[]): xdr.ScVal[] {
  let fn: xdr.ScSpecFunctionV0;
  try {
    fn = spec.getFunc(method);
  } catch {
    const known = spec.funcs().map((f) => f.name().toString()).sort();
    throw new ArgumentError(`Unknown method "${method}". Available: ${known.join(", ")}`);
  }
  const inputs = fn.inputs();
  if (rawArgs.length !== inputs.length) {
    const usage = inputs.map((input) => `<${input.name().toString()}>`).join(" ");
    throw new ArgumentError(`${method} takes ${inputs.length} argument(s): ${method} ${usage}`.trim());
  }
  const named: Record<string, unknown> = {};
  inputs.forEach((input, i) => {
    const name = input.name().toString();
    named[name] = coerceArg(spec, input.type(), rawArgs[i]!, name);
  });
  return spec.funcArgsToScVals(method, named);
}

/** JSON-safe view of decoded contract values: bigint -> string, bytes -> hex. */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [String(k), toJsonSafe(v)]));
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)]));
  }
  return value;
}

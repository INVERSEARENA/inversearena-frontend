/** A small contract spec built in-process, so unit tests need no WASM build. */
import { contract, xdr } from "@stellar/stellar-sdk";

const T = xdr.ScSpecTypeDef;

const input = (name: string, type: xdr.ScSpecTypeDef) => new xdr.ScSpecFunctionInputV0({ doc: "", name, type });

const fn = (name: string, inputs: xdr.ScSpecFunctionInputV0[], outputs: xdr.ScSpecTypeDef[] = []) =>
  xdr.ScSpecEntry.scSpecEntryFunctionV0(new xdr.ScSpecFunctionV0({ doc: "", name, inputs, outputs }));

const udt = (name: string) => T.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name }));

export const ARENA_LIKE_SPEC = new contract.Spec([
  fn("get_arenas", [input("offset", T.scSpecTypeU32()), input("limit", T.scSpecTypeU32())]),
  fn("deposit", [input("from", T.scSpecTypeAddress()), input("amount", T.scSpecTypeI128())]),
  fn("set_activation_delay", [input("delay_secs", T.scSpecTypeU64())]),
  fn("set_global_pause", [input("paused", T.scSpecTypeBool()), input("reason", T.scSpecTypeSymbol())]),
  fn("upgrade", [input("new_wasm_hash", T.scSpecTypeBytesN(new xdr.ScSpecTypeBytesN({ n: 32 })))]),
  fn("reveal_choice", [input("player", T.scSpecTypeAddress()), input("choice", udt("Choice"))]),
  fn("set_status", [input("status", udt("Status"))]),
  fn("maybe_round", [input("round", T.scSpecTypeOption(new xdr.ScSpecTypeOption({ valueType: T.scSpecTypeU32() })))]),
  fn("resolve_round", []),
  xdr.ScSpecEntry.scSpecEntryUdtUnionV0(
    new xdr.ScSpecUdtUnionV0({
      doc: "",
      lib: "",
      name: "Choice",
      cases: ["Heads", "Tails"].map((name) =>
        xdr.ScSpecUdtUnionCaseV0.scSpecUdtUnionCaseVoidV0(new xdr.ScSpecUdtUnionCaseVoidV0({ doc: "", name })),
      ),
    }),
  ),
  xdr.ScSpecEntry.scSpecEntryUdtEnumV0(
    new xdr.ScSpecUdtEnumV0({
      doc: "",
      lib: "",
      name: "Status",
      cases: ["Active", "Finished"].map((name, value) => new xdr.ScSpecUdtEnumCaseV0({ doc: "", name, value })),
    }),
  ),
  xdr.ScSpecEntry.scSpecEntryUdtErrorEnumV0(
    new xdr.ScSpecUdtErrorEnumV0({
      doc: "",
      lib: "",
      name: "ArenaError",
      cases: [
        new xdr.ScSpecUdtErrorEnumCaseV0({ doc: "", name: "NotInitialized", value: 1 }),
        new xdr.ScSpecUdtErrorEnumCaseV0({ doc: "", name: "GracePeriodNotElapsed", value: 12 }),
      ],
    }),
  ),
]);

export const ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
export const CONTRACT = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";

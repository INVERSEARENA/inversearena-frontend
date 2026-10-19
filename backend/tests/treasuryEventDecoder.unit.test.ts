import { test } from "node:test";
import assert from "node:assert";
import { nativeToScVal, type rpc, xdr } from "@stellar/stellar-sdk";
import { toTreasuryEvent } from "../src/domain/treasuryEventDecoder";

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const WINNER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const TREASURY = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

const symbol = (value: string): xdr.ScVal => nativeToScVal(value, { type: "symbol" });
const address = (value: string): xdr.ScVal => nativeToScVal(value, { type: "address" });
const i128 = (value: bigint): xdr.ScVal => nativeToScVal(value, { type: "i128" });
const u32 = (value: number): xdr.ScVal => nativeToScVal(value, { type: "u32" });
/** Soroban encodes contract tuples as an ScVal vec. */
const tuple = (...items: xdr.ScVal[]): xdr.ScVal => xdr.ScVal.scvVec(items);

function eventResponse(topic: xdr.ScVal[], value: xdr.ScVal): rpc.Api.EventResponse {
  return {
    id: "evt-1",
    type: "contract",
    ledger: 42,
    ledgerClosedAt: "2026-01-01T00:00:00.000Z",
    contractId: CONTRACT_ID,
    txHash: "tx-1",
    topic,
    value,
  } as unknown as rpc.Api.EventResponse;
}

test("decodes a #1554 claimed event as a (gross, fee, net, yield_amount, treasury) 5-tuple", () => {
  const decoded = toTreasuryEvent(
    eventResponse(
      [symbol("claimed"), address(WINNER)],
      tuple(
        i128(1100n),
        i128(100n),
        i128(1000n),
        i128(500n),
        address(TREASURY),
      ),
    ),
  );

  assert.strictEqual(decoded.topic, "claimed");
  if (decoded.topic !== "claimed") return;
  assert.strictEqual(decoded.winner, WINNER);
  assert.strictEqual(decoded.grossAtomic, 1100n);
  assert.strictEqual(decoded.feeAtomic, 100n);
  assert.strictEqual(decoded.netAtomic, 1000n);
  assert.strictEqual(decoded.yieldAmountAtomic, 500n);
  assert.strictEqual(decoded.treasury, TREASURY);
});

test("records a malformed claimed payload (wrong arity) as unknown rather than throwing", () => {
  const decoded = toTreasuryEvent(
    eventResponse(
      [symbol("claimed"), address(WINNER)],
      tuple(i128(1100n), i128(100n)),
    ),
  );

  assert.strictEqual(decoded.topic, "unknown");
  if (decoded.topic !== "unknown") return;
  assert.match(decoded.reason, /5-tuple/);
});

test("decodes a #1554 fee_coll event as (fee, fee_bps)", () => {
  const decoded = toTreasuryEvent(
    eventResponse(
      [symbol("fee_coll"), address(TREASURY)],
      tuple(i128(100n), u32(1000)),
    ),
  );

  assert.strictEqual(decoded.topic, "fee_coll");
  if (decoded.topic !== "fee_coll") return;
  assert.strictEqual(decoded.treasury, TREASURY);
  assert.strictEqual(decoded.feeAtomic, 100n);
  assert.strictEqual(decoded.feeBps, 1000);
});

test("still decodes the legacy fee_upd event (admin, fee_bps)", () => {
  const decoded = toTreasuryEvent(
    eventResponse([symbol("fee_upd"), address(WINNER)], nativeToScVal(750, { type: "u32" })),
  );

  assert.strictEqual(decoded.topic, "fee_upd");
  if (decoded.topic !== "fee_upd") return;
  assert.strictEqual(decoded.admin, WINNER);
  assert.strictEqual(decoded.feeBps, 750);
});

test("ignores non-treasury topics", () => {
  const decoded = toTreasuryEvent(
    eventResponse([symbol("join")], nativeToScVal(1, { type: "u32" })),
  );

  assert.strictEqual(decoded.topic, "unknown");
});

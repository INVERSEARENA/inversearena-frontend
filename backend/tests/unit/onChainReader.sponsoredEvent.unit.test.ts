/**
 * Raw event decoder coverage for the #1715 sponsored join.
 *
 * The projection decoder historically understood uppercase single-symbol
 * topics only. `join_spon` is a new normalized (#1607) event, so it needs its
 * own fixture — otherwise a real sponsored join would be silently recorded as
 * UNKNOWN and never reach the projection fold.
 */
import { Address, Keypair, nativeToScVal, xdr, type rpc } from "@stellar/stellar-sdk";

import { toArenaProjectionEvent } from "../../src/services/onChainReader";

const CONTRACT = "CARENA0000000000000000000000000000000000000000000000";

function rawEvent(
  topic: xdr.ScVal[],
  value: xdr.ScVal,
): rpc.Api.EventResponse {
  return {
    type: "contract",
    id: "0000000000000001-0000000000",
    ledger: 101,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    contractId: CONTRACT,
    topic,
    value,
    txHash: "tx-sponsored",
  } as unknown as rpc.Api.EventResponse;
}

describe("toArenaProjectionEvent — sponsored join (#1715)", () => {
  it("decodes the normalized arena/join_spon topics into a JOIN_S event", () => {
    const payer = Keypair.random().publicKey();
    const player = Keypair.random().publicKey();
    const raw = rawEvent(
      [
        nativeToScVal("arena", { type: "symbol" }),
        nativeToScVal("join_spon", { type: "symbol" }),
        new Address(payer).toScVal(),
        new Address(player).toScVal(),
      ],
      xdr.ScVal.scvVec([
        nativeToScVal(1, { type: "u32" }),
        nativeToScVal(4, { type: "u32" }),
      ]),
    );

    expect(toArenaProjectionEvent(raw)).toMatchObject({
      topic: "JOIN_S",
      payer,
      player,
      playerCount: 4,
      contractId: CONTRACT,
      ledgerSequence: 101,
    });
  });

  it("records a malformed sponsored event as UNKNOWN instead of throwing", () => {
    const raw = rawEvent(
      [
        nativeToScVal("arena", { type: "symbol" }),
        nativeToScVal("join_spon", { type: "symbol" }),
      ],
      xdr.ScVal.scvVec([nativeToScVal(1, { type: "u32" })]),
    );

    expect(toArenaProjectionEvent(raw)).toMatchObject({
      topic: "UNKNOWN",
      rawTopic: "arena",
    });
  });
});

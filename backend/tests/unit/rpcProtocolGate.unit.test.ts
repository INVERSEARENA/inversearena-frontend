import assert from "node:assert/strict";
import test from "node:test";
import { checkRpcProtocolSupport } from "../../src/services/rpcProtocolGate";

test("rpc protocol gate returns unsupported on probe failure", async () => {
  const prev = {
    url: process.env.SOROBAN_RPC_URL,
    pass: process.env.STELLAR_NETWORK_PASSPHRASE,
    min: process.env.SUPPORTED_RPC_PROTOCOL_MIN,
    max: process.env.SUPPORTED_RPC_PROTOCOL_MAX,
  };
  process.env.SOROBAN_RPC_URL = "http://127.0.0.1:1";
  process.env.STELLAR_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
  process.env.SUPPORTED_RPC_PROTOCOL_MIN = "20";
  process.env.SUPPORTED_RPC_PROTOCOL_MAX = "30";
  const res = await checkRpcProtocolSupport();
  assert.equal(res.ok, false);
  assert.equal(res.supportedMin, 20);
  assert.equal(res.supportedMax, 30);
  process.env.SOROBAN_RPC_URL = prev.url;
  process.env.STELLAR_NETWORK_PASSPHRASE = prev.pass;
  process.env.SUPPORTED_RPC_PROTOCOL_MIN = prev.min;
  process.env.SUPPORTED_RPC_PROTOCOL_MAX = prev.max;
});

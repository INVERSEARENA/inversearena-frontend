import { test } from "node:test";
import { strict as assert } from "node:assert";
import { sha256, verifyApprovedMutation, type MutationPlan } from "../src/mutation-plan.js";
const plan: MutationPlan = {
 version:1, command:"invoke", manifestDigest:"abc", networkPassphrase:"Test",
 contractId:"C1",contractVersion:"v1",signerPublicKey:"G1",signerRole:"operator",
 args:["1"],simulationDigest:"xyz",maxFeeStroops:"1000",
 minLedger:1,maxLedger:100,expiresAt:"2099-01-01T00:00:00.000Z",
};
test("canonical digests ignore object insertion order", () => {
 assert.equal(sha256({b:2,a:1}),sha256({a:1,b:2}));
});
test("drift, expiry, signer and manifest substitution reject", () => {
 const hash=sha256(plan);
 verifyApprovedMutation(plan,plan,hash);
 for(const mutation of [{manifestDigest:"changed"},{signerPublicKey:"other"},
  {args:["2"]},{networkPassphrase:"Mainnet"},{simulationDigest:"other"},{maxFeeStroops:"1001"}]) {
   assert.throws(()=>verifyApprovedMutation(plan,{...plan,...mutation},hash),/MUTATION_PLAN_DRIFT/);
 }
 assert.throws(()=>verifyApprovedMutation({...plan,expiresAt:"2000-01-01T00:00:00.000Z"},plan,hash),/EXPIRED/);
});

import assert from "node:assert/strict";
import test from "node:test";

import { CreatePoolBodySchema } from "./validation.ts";

const VALID_WALLET = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

test("CreatePoolBodySchema rejects invalid walletAddress", () => {
  const parsed = CreatePoolBodySchema.safeParse({
    name: "Valid Name",
    walletAddress: "invalid-wallet",
  });

  assert.equal(parsed.success, false);
  if (!parsed.success) {
    assert.ok(parsed.error.issues.some((issue) => issue.path.join(".") === "walletAddress"));
  }
});

test("CreatePoolBodySchema rejects overly long name", () => {
  const parsed = CreatePoolBodySchema.safeParse({
    name: "a".repeat(257),
    walletAddress: VALID_WALLET,
  });

  assert.equal(parsed.success, false);
  if (!parsed.success) {
    assert.ok(parsed.error.issues.some((issue) => issue.path.join(".") === "name"));
  }
});

test("CreatePoolBodySchema trims valid fields", () => {
  const parsed = CreatePoolBodySchema.safeParse({
    name: "  Weekly Arena  ",
    walletAddress: `  ${VALID_WALLET}  `,
  });

  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.name, "Weekly Arena");
    assert.equal(parsed.data.walletAddress, VALID_WALLET);
  }
});

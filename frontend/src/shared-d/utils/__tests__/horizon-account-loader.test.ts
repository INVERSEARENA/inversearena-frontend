import { describe, it, expect, jest } from "@jest/globals";
import { Account } from "@stellar/stellar-sdk";
import {
  HorizonAccountFetchError,
  loadAccountFromHorizon,
} from "../horizon-account-loader";

describe("loadAccountFromHorizon", () => {
  it("parses sequence and builds Account on success", async () => {
    const pk =
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ sequence: "42" }),
    })) as unknown as typeof fetch;

    const account = await loadAccountFromHorizon(
      "https://horizon.test",
      pk,
      fetchMock,
    );

    expect(account).toBeInstanceOf(Account);
    expect(account.accountId()).toBe(pk);
    expect(String(account.sequenceNumber())).toBe("42");
    expect(fetchMock).toHaveBeenCalledWith(
      `https://horizon.test/accounts/${pk}`,
    );
  });

  it("throws HorizonAccountFetchError when Horizon returns non-OK", async () => {
    const fetchMock = jest.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    await expect(
      loadAccountFromHorizon(
        "https://horizon.test",
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        fetchMock,
      ),
    ).rejects.toMatchObject({
      name: "HorizonAccountFetchError",
      status: 404,
    });
  });
});

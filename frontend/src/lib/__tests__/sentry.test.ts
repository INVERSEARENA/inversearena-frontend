import { scrubStellarAddresses } from "../sentry";
import type { Event as SentryEvent } from "@sentry/nextjs";

const PUBLIC_KEY = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const PUBLIC_KEY_2 = "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV6NOQHM3OK7";
// A well-formed S… key (not a real secret, used for test assertions only).
const SECRET_KEY = "SCZANGBA5RLMPI7JMILTKOMVHI3NZYDGRQV3SCYIMHZJHQHCQTJCHLIT";

function makeEvent(overrides: Partial<SentryEvent> = {}): SentryEvent {
  return { event_id: "abc123", ...overrides };
}

describe("scrubStellarAddresses", () => {
  it("returns an event unchanged when no wallet addresses are present", () => {
    const event = makeEvent({
      exception: {
        values: [{ type: "Error", value: "Something went wrong" }],
      },
    });
    const result = scrubStellarAddresses(event);
    expect(result).not.toBeNull();
    expect(result!.exception!.values![0]!.value).toBe("Something went wrong");
  });

  it("replaces a public key in an exception value", () => {
    const event = makeEvent({
      exception: {
        values: [
          { type: "Error", value: `Failed to submit choice for ${PUBLIC_KEY}` },
        ],
      },
    });
    const result = scrubStellarAddresses(event);
    expect(result).not.toBeNull();
    expect(result!.exception!.values![0]!.value).toBe(
      "Failed to submit choice for [STELLAR_ADDRESS]",
    );
  });

  it("replaces multiple public keys in exception values", () => {
    const event = makeEvent({
      exception: {
        values: [
          {
            type: "Error",
            value: `Transfer from ${PUBLIC_KEY} to ${PUBLIC_KEY_2} failed`,
          },
        ],
      },
    });
    const result = scrubStellarAddresses(event);
    expect(result!.exception!.values![0]!.value).toBe(
      "Transfer from [STELLAR_ADDRESS] to [STELLAR_ADDRESS] failed",
    );
  });

  it("replaces a public key in a breadcrumb message", () => {
    const event = makeEvent({
      breadcrumbs: [
        { type: "default", message: `Wallet connected: ${PUBLIC_KEY}` },
      ],
    });
    const result = scrubStellarAddresses(event);
    expect(result!.breadcrumbs![0]!.message).toBe(
      "Wallet connected: [STELLAR_ADDRESS]",
    );
  });

  it("replaces a public key embedded in a breadcrumb URL", () => {
    const event = makeEvent({
      breadcrumbs: [
        {
          type: "navigation",
          data: { url: `/arena/${PUBLIC_KEY}/stats` },
        },
      ],
    });
    const result = scrubStellarAddresses(event);
    expect(result!.breadcrumbs![0]!.data!.url).toBe(
      "/arena/[STELLAR_ADDRESS]/stats",
    );
  });

  it("drops the event entirely when a secret key is present anywhere", () => {
    const event = makeEvent({
      exception: {
        values: [{ type: "Error", value: `Secret leaked: ${SECRET_KEY}` }],
      },
    });
    const result = scrubStellarAddresses(event);
    expect(result).toBeNull();
  });

  it("drops the event when the secret key appears only in extra data", () => {
    const event = makeEvent({
      extra: { debug: SECRET_KEY },
    });
    expect(scrubStellarAddresses(event)).toBeNull();
  });

  it("handles events with no exception or breadcrumbs gracefully", () => {
    const event = makeEvent();
    const result = scrubStellarAddresses(event);
    expect(result).not.toBeNull();
    expect(result!.event_id).toBe("abc123");
  });

  it("handles breadcrumbs with no message or url without throwing", () => {
    const event = makeEvent({
      breadcrumbs: [{ type: "default" }],
    });
    expect(() => scrubStellarAddresses(event)).not.toThrow();
  });
});

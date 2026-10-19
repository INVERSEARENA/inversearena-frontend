import { describeUserAgent } from "../src/utils/userAgent";

describe("describeUserAgent", () => {
  it("identifies Chrome on Windows", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
    expect(describeUserAgent(ua)).toBe("Chrome on Windows");
  });

  it("identifies Firefox on macOS", () => {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0";
    expect(describeUserAgent(ua)).toBe("Firefox on macOS");
  });

  it("identifies Safari on iOS", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    expect(describeUserAgent(ua)).toBe("Safari on iOS");
  });

  it("identifies Edge on Windows (not misclassified as Chrome)", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0";
    expect(describeUserAgent(ua)).toBe("Edge on Windows");
  });

  it("returns 'Unknown device' for undefined input", () => {
    expect(describeUserAgent(undefined)).toBe("Unknown device");
  });

  it("returns 'Unknown device' for null input", () => {
    expect(describeUserAgent(null)).toBe("Unknown device");
  });

  it("returns 'Unknown device' for an empty string", () => {
    expect(describeUserAgent("")).toBe("Unknown device");
  });

  it("returns 'Unknown device' for a string matching neither browser nor OS", () => {
    expect(describeUserAgent("SomeWeirdBot/1.0")).toBe("Unknown device");
  });
});

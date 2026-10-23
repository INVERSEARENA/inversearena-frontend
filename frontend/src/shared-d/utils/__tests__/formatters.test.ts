import {
  formatAmount,
  formatBps,
  formatPercent,
  formatCountdown,
  formatCount,
  formatTimestamp,
  decimalSeparator,
  groupSeparator,
} from "../formatters";

describe("formatAmount (#1575)", () => {
  it("keeps BigInt precision without float rounding", () => {
    expect(formatAmount(12_345_678_901_234_567_890n)).toBe(
      "1,234,567,890,123.456789",
    );
    expect(formatAmount(90_071_992_547_409_930n)).toBe("9,007,199,254.740993");
  });

  it("splits integer/fraction by the decimals argument", () => {
    expect(formatAmount(5n, 0)).toBe("5");
    expect(formatAmount(0n, 0)).toBe("0");
    expect(formatAmount(1n, 7)).toBe("0.0000001");
    expect(formatAmount(15_000_000n, 7)).toBe("1.5");
  });

  it("never rounds a sub-unit amount up", () => {
    expect(formatAmount(9_999_999n, 7)).toBe("0.9999999");
    expect(formatAmount(10_000_000n, 7)).toBe("1");
  });

  it("is locale-aware for en, es and de", () => {
    expect(formatAmount(1_234_567n, 0, "en")).toBe("1,234,567");
    expect(formatAmount(1_234_567n, 0, "es")).toBe("1.234.567");
    expect(formatAmount(1_234_567n, 0, "de")).toBe("1.234.567");
    expect(formatAmount(150n, 0, "de")).toBe("150");
    expect(formatAmount(15_050_000n, 7, "en")).toBe("1.505");
    expect(formatAmount(15_050_000n, 7, "de")).toBe("1,505");
  });

  it("handles negative amounts", () => {
    expect(formatAmount(-150n, 0)).toBe("-150");
    expect(formatAmount(-15_000_000n, 7, "de")).toBe("-1,5");
  });

  it("supports signDisplay for positive values", () => {
    expect(formatAmount(150n, 0, "en", { signDisplay: "always" })).toBe("+150");
    expect(formatAmount(0n, 0, "en", { signDisplay: "always" })).toBe("0");
  });

  it("accepts a decimal string and rejects unsafe numbers", () => {
    expect(formatAmount("123450000", 7)).toBe("12.345");
    expect(() => formatAmount(1.5)).toThrow(TypeError);
  });
});

describe("formatBps / formatPercent (#1575)", () => {
  it("converts basis points to a percent string", () => {
    expect(formatBps(500)).toBe("5.00%");
    expect(formatBps(0)).toBe("0.00%");
    expect(formatBps(1)).toBe("0.01%");
  });

  it("formats yield fractions", () => {
    expect(formatPercent(0.05)).toBe("5.00%");
    expect(formatPercent(1)).toBe("100.00%");
  });

  it("is locale-aware for the decimal separator", () => {
    expect(formatBps(500, "de")).toMatch(/5,00\s?%/);
    expect(formatPercent(0.05, "es")).toMatch(/5,00\s?%/);
  });

  it("rejects non-finite rates", () => {
    expect(() => formatBps(Number.NaN)).toThrow(TypeError);
  });
});

describe("formatCountdown (#1575)", () => {
  it("formats durations with narrow unit notation", () => {
    expect(formatCountdown(3_661)).toBe("1h 1m 1s");
    expect(formatCountdown(59)).toBe("59s");
    expect(formatCountdown(90)).toBe("1m 30s");
  });

  it("renders a zero duration", () => {
    expect(formatCountdown(0)).toBe("0s");
  });

  it("rejects invalid input instead of rendering garbage", () => {
    expect(() => formatCountdown(-10)).toThrow(TypeError);
    expect(() => formatCountdown(Number.NaN)).toThrow(TypeError);
  });

  it("is locale-aware for unit names", () => {
    const es = formatCountdown(3_661, "es");
    expect(es).not.toBe(formatCountdown(3_661, "en"));
    expect(es).toContain("h");
  });
});

describe("formatCount / formatTimestamp (#1575)", () => {
  it("groups large counts per locale", () => {
    expect(formatCount(1_234_567)).toBe("1,234,567");
    expect(formatCount(1_234_567, "de")).toBe("1.234.567");
    expect(formatCount(42)).toBe("42");
  });

  it("formats a unix-seconds timestamp in the requested locale", () => {
    const unixSeconds = Date.UTC(2026, 0, 2, 3, 4, 5) / 1000;
    const en = formatTimestamp(unixSeconds, "en");
    expect(en).toContain("2026");
    const de = formatTimestamp(unixSeconds, "de");
    expect(de).toContain("2026");
    expect(de).not.toBe(en);
  });
});

describe("decimalSeparator / groupSeparator (#1575)", () => {
  it("differs between en and de", () => {
    expect(decimalSeparator("en")).toBe(".");
    expect(decimalSeparator("de")).toBe(",");
    expect(groupSeparator("en")).toBe(",");
    expect(groupSeparator("de")).toBe(".");
  });
});

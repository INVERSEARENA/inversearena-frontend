import { poolSchema, MIN_CAPACITY, MAX_CAPACITY } from "../pool-schema";

describe("poolSchema", () => {
  const validInput = {
    stakeAmount: "100",
    currency: "USDC" as const,
    roundSpeed: "1M" as const,
    arenaCapacity: 50,
  };

  it("accepts valid input", () => {
    const result = poolSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("rejects empty stake amount", () => {
    const result = poolSchema.safeParse({ ...validInput, stakeAmount: "" });
    expect(result.success).toBe(false);
  });

  it("rejects zero stake amount", () => {
    const result = poolSchema.safeParse({ ...validInput, stakeAmount: "0" });
    expect(result.success).toBe(false);
  });

  it("rejects negative stake amount", () => {
    const result = poolSchema.safeParse({ ...validInput, stakeAmount: "-10" });
    expect(result.success).toBe(false);
  });

  it("rejects non-numeric stake amount", () => {
    const result = poolSchema.safeParse({ ...validInput, stakeAmount: "abc" });
    expect(result.success).toBe(false);
  });

  it("accepts valid XLM currency", () => {
    const result = poolSchema.safeParse({ ...validInput, currency: "XLM" });
    expect(result.success).toBe(true);
  });

  it("rejects invalid currency", () => {
    const result = poolSchema.safeParse({ ...validInput, currency: "BTC" });
    expect(result.success).toBe(false);
  });

  it("accepts all round speed variants", () => {
    for (const speed of ["30S", "1M", "5M"] as const) {
      const result = poolSchema.safeParse({ ...validInput, roundSpeed: speed });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid round speed", () => {
    const result = poolSchema.safeParse({ ...validInput, roundSpeed: "10M" });
    expect(result.success).toBe(false);
  });

  it("rejects arena capacity below minimum", () => {
    const result = poolSchema.safeParse({
      ...validInput,
      arenaCapacity: MIN_CAPACITY - 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects arena capacity above maximum", () => {
    const result = poolSchema.safeParse({
      ...validInput,
      arenaCapacity: MAX_CAPACITY + 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer arena capacity", () => {
    const result = poolSchema.safeParse({
      ...validInput,
      arenaCapacity: 50.5,
    });
    expect(result.success).toBe(false);
  });

  it("accepts minimum capacity boundary", () => {
    const result = poolSchema.safeParse({
      ...validInput,
      arenaCapacity: MIN_CAPACITY,
    });
    expect(result.success).toBe(true);
  });

  it("accepts maximum capacity boundary", () => {
    const result = poolSchema.safeParse({
      ...validInput,
      arenaCapacity: MAX_CAPACITY,
    });
    expect(result.success).toBe(true);
  });
});

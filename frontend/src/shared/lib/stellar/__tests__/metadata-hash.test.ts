import { canonicalizeMetadata, hashMetadata, verifyMetadataHash } from "../metadata-hash";

describe("canonical metadata hashing (#1577)", () => {
  const metadata = {
    name: "Alpha Arena",
    description: "Fast rounds",
    rules: "Reveal before the deadline.",
    banner: "https://example.com/banner.png",
  };

  // Golden vector shared with the backend and Rust tests.
  const expectedHash =
    "05f1a22d4e08e7e4cdde2423a6e59f3470fddc279e7dd33f98973a21fc6385e7";

  it("sorts keys and removes insignificant whitespace", () => {
    expect(canonicalizeMetadata(metadata)).toBe(
      '{"banner":"https://example.com/banner.png","description":"Fast rounds","name":"Alpha Arena","rules":"Reveal before the deadline."}',
    );
  });

  it("is independent of insertion order", () => {
    const reordered = {
      rules: metadata.rules,
      banner: metadata.banner,
      name: metadata.name,
      description: metadata.description,
    };
    expect(canonicalizeMetadata(reordered)).toBe(canonicalizeMetadata(metadata));
  });

  it("produces the documented golden hash", async () => {
    await expect(hashMetadata(metadata)).resolves.toBe(expectedHash);
  });

  it("verifies a matching hash and rejects a mismatch", async () => {
    await expect(verifyMetadataHash(metadata, expectedHash)).resolves.toBe(true);
    await expect(verifyMetadataHash(metadata, "00".repeat(32))).resolves.toBe(false);
  });
});

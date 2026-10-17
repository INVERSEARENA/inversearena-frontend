import {
  canonicalizeMetadata,
  hashMetadata,
  verifyMetadataHash,
} from "../src/utils/metadataHash";

describe("canonical metadata hashing (#1577)", () => {
  const metadata = {
    name: "Alpha Arena",
    description: "Fast rounds",
    rules: "Reveal before the deadline.",
    banner: "https://example.com/banner.png",
  };

  const expectedHash =
    "05f1a22d4e08e7e4cdde2423a6e59f3470fddc279e7dd33f98973a21fc6385e7";

  it("sorts keys and removes insignificant whitespace", () => {
    expect(canonicalizeMetadata(metadata)).toBe(
      '{"banner":"https://example.com/banner.png","description":"Fast rounds","name":"Alpha Arena","rules":"Reveal before the deadline."}',
    );
  });

  it("produces the documented golden hash", () => {
    expect(hashMetadata(metadata)).toBe(expectedHash);
  });

  it("verifies a matching hash and rejects a mismatch", () => {
    expect(verifyMetadataHash(metadata, expectedHash)).toBe(true);
    expect(verifyMetadataHash(metadata, "00".repeat(32))).toBe(false);
  });
});

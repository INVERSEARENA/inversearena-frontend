import { redactForExport } from "../../frontend/src/shared-d/security/redaction";

describe("shared redaction policy (#1531)", () => {
  it("redacts JWT-like strings and authorization headers", () => {
    const output = redactForExport({
      headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhIjoxfQ.sig" },
      nested: { refreshToken: "should-not-leak" },
      txHash: "a".repeat(64),
    });

    expect(output).not.toContain("eyJhbGci");
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("a".repeat(64));
  });
});

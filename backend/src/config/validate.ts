export function validateConfig(): void {
  const ttl = parseInt(process.env.ADMIN_TOKEN_TTL_SECONDS ?? "", 10);
  if (Number.isFinite(ttl) && ttl > 0 && ttl < 300) {
    throw new Error(
      "ADMIN_TOKEN_TTL_SECONDS must be at least 300 seconds (5 minutes) " +
        "or 0 for API key auth (no expiring tokens)"
    );
  }

  const apiKey = process.env.ADMIN_API_KEY ?? "";
  if (apiKey.length < 32) {
    throw new Error(
      "ADMIN_API_KEY must be at least 32 characters to resist " +
        "brute-force and timing attacks"
    );
  }
  if (apiKey === "change-me-in-production") {
    throw new Error(
      "ADMIN_API_KEY must be changed from the default value"
    );
  }
}

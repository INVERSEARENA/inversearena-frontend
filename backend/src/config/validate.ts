import { checkRotationReadiness, type RotationReadiness, type SecretPurpose } from "./secretKeyring";
import { logger } from "../utils/logger";

export function validateConfig(): void {
  const apiKey = process.env.ADMIN_API_KEY ?? "";
  if (apiKey === "change-me-in-production") {
    throw new Error(
      "ADMIN_API_KEY must be changed from the default value"
    );
  }
  if (apiKey.length < 32) {
    throw new Error(
      "ADMIN_API_KEY must be at least 32 characters to resist " +
        "brute-force and timing attacks"
    );
  }

  const ttl = parseInt(process.env.ADMIN_TOKEN_TTL_SECONDS ?? "", 10);
  if (Number.isFinite(ttl) && ttl > 0 && ttl < 300) {
    throw new Error(
      "ADMIN_TOKEN_TTL_SECONDS must be at least 300 seconds (5 minutes) " +
        "or 0 for API key auth (no expiring tokens)"
    );
  }

  assertSecretRotationReadiness();
}

/**
 * Boot-time secret rotation readiness (#1456): fail fast on a keyring that
 * would reject valid traffic or accept keys indefinitely, and log the
 * rotation state so operators can confirm an overlap window is open/closed.
 */
export function assertSecretRotationReadiness(
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): RotationReadiness[] {
  const purposes: SecretPurpose[] = ["jwt", "webhook"];
  const reports = purposes.map((purpose) => checkRotationReadiness(purpose, env, now));
  for (const report of reports) {
    const { errors, warnings, ...state } = report;
    logger.info({ event: "secret_rotation_readiness", ...state, warnings }, "secret rotation readiness");
    for (const warning of warnings) logger.warn({ event: "secret_rotation_warning", purpose: report.purpose }, warning);
  }
  const errors = reports.flatMap((report) => report.errors);
  if (errors.length > 0) throw new Error(`Secret rotation misconfigured: ${errors.join("; ")}`);
  return reports;
}

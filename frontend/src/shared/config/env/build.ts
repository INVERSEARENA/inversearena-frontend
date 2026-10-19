/**
 * Build-time environment checks, run by next.config.ts (#1650).
 *
 * - Always, in every phase: fail if a `NEXT_PUBLIC_` variable looks like a
 *   secret, by name or by value. Those are inlined into the browser bundle.
 * - In `next build`: fail on any missing or malformed variable, so a
 *   deployment cannot ship with a broken config. `SKIP_ENV_VALIDATION=1`
 *   opts out of this part only.
 * - In `next dev` (`warn`): print the same problems as a warning. Pages
 *   without a Stellar dependency keep working (#1134) and StellarSetupBanner
 *   names what is missing.
 * - Otherwise (tests, `next start`): only the secret check.
 */
import {
  CLIENT_ENV_VARS,
  EnvValidationError,
  SERVER_ENV_VARS,
  checkEnv,
  findPublicSecretExposures,
} from "./spec";

type Source = Readonly<Record<string, string | undefined>>;

export function validateBuildEnv(
  source: Source,
  { strict, warn = !strict }: { strict: boolean; warn?: boolean },
): void {
  const exposures = findPublicSecretExposures(source);
  if (exposures.length > 0) {
    throw new EnvValidationError(exposures, "Secret-looking NEXT_PUBLIC_ environment variables");
  }

  const issues = [...checkEnv(CLIENT_ENV_VARS, source), ...checkEnv(SERVER_ENV_VARS, source)];
  if (issues.length === 0) return;

  const skip = source.SKIP_ENV_VALIDATION === "1" || source.SKIP_ENV_VALIDATION === "true";
  const error = new EnvValidationError(issues);
  if (strict && !skip) throw error;
  if (warn) console.warn(`[env] ${error.message}`);
}

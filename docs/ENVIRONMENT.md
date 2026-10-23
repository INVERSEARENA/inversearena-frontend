# Environment configuration

Both apps declare every environment variable they read in a typed schema
(#1650). The schema is the single source of truth: it validates values, types
access in code, and generates each app's `.env.example`.

| App | Schema | Generated example |
| --- | --- | --- |
| Backend | `backend/src/config/env.ts` | `backend/.env.example` |
| Frontend | `frontend/src/shared/config/env/spec.ts` | `frontend/.env.example` |

## Adding or changing a variable

1. Declare it in the app's schema with a `section`, a `description`, a
   validator, and `required`, `secret`, `default` or `example` as they apply.
2. Read it through the app's accessor (see below).
3. Regenerate the examples and commit them:

   ```bash
   npx tsx scripts/env-example.ts            # both apps
   npx tsx scripts/env-example.ts backend    # one app
   ```

CI runs `scripts/env-example.ts <app> --check` and fails when a committed
`.env.example` differs from its schema.

## Backend

- **Single access point.** `src/config/env.ts` is the only file that reads
  `process.env`. Elsewhere, use `env.NAME`, which is typed and throws on an
  undeclared name. Config helpers that accept an injectable environment take
  `processEnv` as their default. `npm run lint` (in CI) rejects `process.env`
  anywhere else in `src/`. Tests are exempt.
- **Fail fast at boot.** `server.ts` imports `config/bootEnv` right after
  `dotenv/config`. Before any connection opens, it validates every variable
  and exits with one message listing each problem:

  ```text
  Invalid environment configuration (3 variables):
    - ADMIN_API_KEY: must be at least 32 characters
    - MONGODB_URI: is required but not set
    - PORT: must be an integer
  ```

  Messages name the variable and the rule, never the value.
- **Tests.** `env` and `processEnv` read through to the current
  `process.env` on every access, so tests can set variables, or replace
  `process.env` entirely, before exercising code. Feature config modules keep
  their own parsing and defaults.

## Frontend

- **Client vs server.** `CLIENT_ENV_VARS` holds `NEXT_PUBLIC_*` values, which
  Next.js inlines into the browser bundle, so they are public. Read them
  through `clientEnv` (`shared/config/env/client.ts`), which names each one
  literally, as inlining requires. Server-only values are in
  `SERVER_ENV_VARS`, read through `serverEnv`, which throws if read in the
  browser. Both modules are Edge-runtime safe.
- **Secrets cannot go public.** In every `next` phase, `next.config.ts` fails
  if a `NEXT_PUBLIC_` variable has a secret-looking name (`SECRET`, `TOKEN`,
  `PRIVATE`, `API_KEY`, `SEED`, `REDIS_URL`, …) or holds a Stellar secret seed
  or PEM private key.
- **Build vs dev.** `next build` fails on any missing or malformed variable.
  `next dev` only warns, so pages without a Stellar dependency keep working
  (#1134) and the setup banner names what is missing. To build an image before
  its environment exists, set `SKIP_ENV_VALIDATION=1`. That skips schema
  validation but not the secret check.

## Notes from the migration

The previous hand-written examples had drifted from the code. Deployments
copied from them may need updating:

- `JWT_EXPIRES_IN` was never read. The access-token lifetime is
  `JWT_ACCESS_EXPIRES_IN`, in seconds.
- `JWT_REFRESH_EXPIRES_IN=7d` was silently ignored: the value is parsed as
  seconds, and `7d` fell back to the default. It must now be an integer
  (`604800` for 7 days), or boot fails.
- `RATE_LIMIT_*_PREFIX` were never read. The tunables are
  `RATE_LIMIT_<CLASS>_POINTS` and `_WINDOW_SECONDS`.
- `CONTRACT_MANIFEST_PATH` (backend) and `NEXT_PUBLIC_CONTRACT_MANIFEST_PATH`
  (frontend) were not read by either app.

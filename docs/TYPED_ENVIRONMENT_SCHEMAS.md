# Typed Environment Schemas & Configuration Architecture

## Overview

This document specifies the typed environment configuration architecture for both frontend (Next.js) and backend (Express/Node.js) services in InverseArena.

### Core Objectives
1. **Type Safety & Runtime Validation**: Validates all environment variables using Zod schemas at startup/build time.
2. **Fail-Fast Boot**: Invalid or missing variables crash fast with clear, actionable error summaries detailing every offending field.
3. **Secret Leak Prevention**: Frontend build fails immediately if any secret-like variable (tokens, keys, secrets, credentials) is prefixed with `NEXT_PUBLIC_`.
4. **Single Source of Truth**: All backend configuration is accessed via a single validated module (`backend/src/config/index.ts`). Direct `process.env` access outside `backend/src/config/` is strictly banned and enforced via ESLint rules and CI checks.
5. **Zero-Drift `.env.example` Files**: `.env.example` files are programmatically generated with field documentation and defaults directly from the Zod schemas. CI enforces drift detection.

---

## Architecture

### Frontend Configuration (`frontend/src/config/env.ts`)

The frontend separates environment variables into two schemas:
- **`clientEnvSchema`**: Variables prefixed with `NEXT_PUBLIC_` that are bundled into client-side JavaScript.
  - Examples: `NEXT_PUBLIC_STELLAR_NETWORK`, `NEXT_PUBLIC_BACKEND_URL`, `NEXT_PUBLIC_HORIZON_URL`, `NEXT_PUBLIC_SOROBAN_RPC_URL`, `NEXT_PUBLIC_EXPLORER_URL`.
- **`serverEnvSchema`**: Variables available only in Node.js runtime (SSR, Route Handlers, Server Actions).
  - Examples: `API_URL`, `BACKEND_URL`, `NODE_ENV`.

#### Secret Leak Protection
`detectLeakedSecrets(env)` inspects all environment variables starting with `NEXT_PUBLIC_`. If any variable key contains patterns matching secrets (e.g. `SECRET`, `PRIVATE_KEY`, `TOKEN`, `PASSWORD`, `API_KEY`, `AUTH_KEY`, `MNEMONIC`, `SEED`), validation immediately throws `SecretLeakError` and halts the build:
```typescript
import { detectLeakedSecrets } from './env';

const leaked = detectLeakedSecrets(process.env);
if (leaked.length > 0) {
  throw new SecretLeakError(leaked);
}
```
This is integrated directly into `frontend/next.config.ts` so `next build` fails before bundling.

---

### Backend Configuration (`backend/src/config/index.ts` & `env.ts`)

The backend configuration is centralized in `backend/src/config/`:
- **`backendEnvSchema`**: Comprehensive Zod schema defining all backend configuration items, types, transformations, and default values (database URIs, Redis, Stellar RPCs, JWT secrets, security thresholds).
- **`validateBackendEnv(env)`**: Parses and validates the environment, providing formatted error output listing all missing or invalid fields.
- **`config` Singleton**: Exported from `backend/src/config/index.ts`, providing a fully typed, frozen configuration object.
- **Lint Enforcement**: Direct reads of `process.env` outside `backend/src/config/` are banned via:
  - ESLint `no-restricted-properties` in `backend/eslint.config.mjs`.
  - CI verification script `node scripts/check-backend-env-lint.mjs`.

---

## Generated `.env.example` Files & CI Drift Checks

The script `scripts/generate-env-examples.mjs` generates documented `.env.example` files directly from schema specifications:
- `frontend/.env.example`
- `backend/.env.example`

### Running the Generator
```bash
# Regenerate .env.example files
node scripts/generate-env-examples.mjs

# Verify .env.example files match schema definitions (CI mode)
node scripts/generate-env-examples.mjs --check
```

### CI Workflows
- **Frontend CI (`.github/workflows/frontend-ci.yml`)**:
  - Runs `node scripts/generate-env-examples.mjs --check`
  - Runs frontend unit tests covering `detectLeakedSecrets()` and schema validation.
- **Backend CI (`.github/workflows/backend-ci.yml`)**:
  - Runs `node scripts/generate-env-examples.mjs --check`
  - Runs `node scripts/check-backend-env-lint.mjs` to ensure 0 direct `process.env` reads.
  - Runs backend unit tests covering schema validation.

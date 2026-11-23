# Documentation portal

A dependency-free static documentation portal built with Node 20+ ESM. Source Markdown is never moved or rewritten in place.

## Commands

Run from the repository root:

```sh
node --test docs-portal/scripts/*.test.mjs
node docs-portal/scripts/check-links.mjs
node docs-portal/scripts/generate-openapi.mjs
node docs-portal/scripts/generate-contract-docs.mjs
node docs-portal/scripts/build.mjs
```

Equivalent scripts are available from `docs-portal/`: `pnpm test`, `pnpm links`, `pnpm generate`, `pnpm generate:openapi`, `pnpm generate:contracts`, and `pnpm build`.

## Output

- `docs-portal/data/openapi.json`: generated backend OpenAPI 3.1 document.
- `docs-portal/data/contracts/*.md`: generated Rust contract API pages plus `index.md`.
- `docs-portal/dist/`: the static site, ready to upload as a GitHub Pages artifact.

`dist/` is regenerated from scratch on every build and contains:

- `index.html` with area sections and generated-data links.
- `pages/<slug>.html` for each source document.
- `search-index.json` for client-side search.
- `assets/styles.css` and `assets/search.js`.
- `data/` copied from `docs-portal/data/`.

## Markdown sources

The portal reads Markdown from:

| Area | Location |
| --- | --- |
| Root | repository root `*.md` |
| Docs | `docs/**/*.md` |
| Backend | `backend/docs/**/*.md` |
| Frontend | `frontend/docs/**/*.md` |
| Contract | `contract/**/*.md` |

Titles come from the first H1, or from the filename when no H1 exists. Slugs are the area prefix plus the source-relative path, so `README.md` files in different areas do not collide.

## Generators

`generate-openapi.mjs` creates a temporary ESM entry that imports `generateOpenApiDocument()` from `backend/src/openapi/registerPaths.ts` and runs it with `backend/node_modules/.bin/tsx`, falling back to `npx --no-install tsx`. No dependencies are installed by the portal. Backend dependencies must already be present (`pnpm install --frozen-lockfile --filter inversearena-backend...` in `backend/`). The result is validated for OpenAPI 3.1, at least one path, and `components.securitySchemes.bearerAuth`. Use `--check` in CI to compare the generated document with the tracked artifact. If the artifact is missing, `--check` bootstraps it and asks for it to be committed.

`generate-contract-docs.mjs` scans `.rs` files under `contract/*/src`, collecting `///` and `//!` doc comments directly preceding `pub fn`, `pub trait`, trait `fn`, and `impl` entries. The `cost-bench` crate is skipped. Pages are deterministic and sorted by crate, file, line, and name. Use `--check` to fail when tracked pages are missing, outdated, or unexpected.

## Links

`check-links.mjs` validates relative targets and Markdown heading anchors, ignores HTTP(S), mailto, fenced code, inline code, and HTML comments, and verifies that navigation covers every portal source with unique slugs. `backend/README.md`, `frontend/README.md`, and `frontend/IMPLEMENTATION_SUMMARY.md` are checked for links but are not portal pages.

Known pre-existing broken links are listed in `link-allowlist.json`:

- `README.md` links to the untracked root `LICENSE`.
- `backend/README.md` links to five untracked local documents: `QUICKSTART_ROUNDS.md`, `docs/ROUND_STATE_MACHINE.md`, `docs/PAYOUT_EXECUTION.md`, `docs/QUICKSTART_ROUNDS.md`, and `docs/IMPLEMENTATION_SUMMARY.md`.

Do not add entries for new links. Fix the link or the target instead.

## Referencing generated assets

Source docs may link to generated files with their repository-relative paths, for example:

```md
[OpenAPI JSON](../docs-portal/data/openapi.json)
[Oracle API](../docs-portal/data/contracts/oracle.md)
```

The link checker resolves these paths in the repository, and the build rewrites them to `../data/...` for the generated pages under `dist/pages/`.

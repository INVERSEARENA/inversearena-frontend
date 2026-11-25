# Documentation portal

The documentation portal is a static site generated from repository Markdown. It has no Astro, Docusaurus, or npm runtime dependencies; the generator uses only Node 20+ ESM built-ins.

## Architecture

- `docs-portal/scripts/sources.mjs` discovers source Markdown and derives titles, area prefixes, slugs, and navigation.
- `docs-portal/scripts/markdown.mjs` provides a minimal GitHub-style renderer with HTML escaping, headings, paragraphs, lists, inline code, fenced code blocks, links, and Mermaid preservation.
- `docs-portal/scripts/build.mjs` writes `docs-portal/dist/` with a home page, per-page HTML, a search index, static assets, and copied generated data.
- `docs-portal/scripts/generate-openapi.mjs` runs the backend's `generateOpenApiDocument()` headlessly through `tsx`.
- `docs-portal/scripts/generate-contract-docs.mjs` extracts Rust doc comments into deterministic Markdown pages.
- `docs-portal/scripts/check-links.mjs` validates relative links, heading anchors, navigation coverage, and slug uniqueness.
- `docs-portal/link-allowlist.json` records only known pre-existing broken links.

Source areas:

| Area | Source |
| --- | --- |
| Root | repository root `*.md` |
| Docs | `docs/**/*.md` |
| Backend | `backend/docs/**/*.md` |
| Frontend | `frontend/docs/**/*.md` |
| Contract | `contract/**/*.md` |

Mermaid fences are emitted as `<pre class="language-mermaid">`. A Mermaid CDN bootstrap script is added only to pages that contain a Mermaid block.

## Source-of-truth rules

- Markdown files stay where they are; the portal never moves or rewrites source documents.
- The first H1 is the page title. Without an H1, the filename is used.
- Slugs are `<area>-<source-relative-path>`, which keeps duplicate `README.md` files distinct.
- `docs-portal/data/` is generated output. Do not hand-edit it.
- `docs-portal/dist/` is build output. Do not commit it.
- Generated contract pages come from Rust doc comments; update the Rust sources, not the generated Markdown.
- The OpenAPI artifact comes from `backend/src/openapi/registerPaths.ts`; update the backend generator or schemas, not the JSON.
- Allowlist entries are limited to the pre-existing missing root `LICENSE` and backend README document links described in [the portal README](../docs-portal/README.md).

## Commands

From the repository root:

```sh
node --test docs-portal/scripts/*.test.mjs
node docs-portal/scripts/check-links.mjs
node docs-portal/scripts/generate-openapi.mjs
node docs-portal/scripts/generate-contract-docs.mjs
node docs-portal/scripts/generate-openapi.mjs --check
node docs-portal/scripts/generate-contract-docs.mjs --check
node docs-portal/scripts/build.mjs
```

Backend dependencies are required for OpenAPI generation. Install them in the backend workspace with `npm ci` before running the generator; the portal itself installs nothing.

## Adding documentation

1. Add or edit a Markdown file under one of the source areas.
2. Start the page with a descriptive H1.
3. Use relative links for repository files and heading anchors for headings. Links inside fenced code, inline code, and HTML comments are ignored by the checker.
4. Run the link check and build. Every source document must appear in navigation with a unique slug.

To reference a generated asset from a source document, link to its repository path, such as `[OpenAPI JSON](../docs-portal/data/openapi.json)` from `docs/`. The build rewrites those links to the copied `dist/data/` location.

## CI and deploy

`.github/workflows/docs-portal.yml` runs on pull requests and pushes to `main` when Markdown roots, backend OpenAPI sources, contract sources, `docs-portal/**`, or the workflow itself change. The build job uses Node 20.20.2, installs backend dependencies with `npm ci`, runs both generator checks, the link check, unit tests, and the build, then uploads `docs-portal/dist/` with `actions/upload-pages-artifact@v3`.

The deploy job runs only on pushes to `main`, uses `actions/deploy-pages@v4`, and targets the `github-pages` environment. Permissions are `contents: read`, `pages: write`, and `id-token: write`. The `pages` concurrency group uses `cancel-in-progress: false`.

## Integration notes

The dependency-free implementation does not require frontend installs or new runtime packages. Repository-level command shortcuts and ignore rules are maintained outside this portal; see [the portal README](../docs-portal/README.md) for the direct commands.

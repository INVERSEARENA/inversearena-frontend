# Automated dependency updates

Renovate (`renovate.json` at the repository root) opens dependency update PRs for npm, pnpm, Cargo, and GitHub Actions.

## What it does

- **Schedule:** non-security updates run before 06:00 UTC on Mondays. Security alerts run at any time.
- **Groups:** Stellar SDKs, Next and React, Soroban SDK, and GitHub Actions each get one PR.
- **Major updates:** labelled `major-update` and held behind the Dependency Dashboard until a maintainer approves them. Soroban SDK updates always need approval because they can require contract changes.
- **Automerge:** only minor and patch updates to dev dependencies, and only once CI and the dependency threat gate pass.

## Threat gate

The `Dependency Threat Gate` workflow (`.github/workflows/dependency-gate.yml`) runs on any PR that changes `frontend/package.json`, the lockfiles, or a `Cargo.toml`, so Renovate PRs are checked automatically. A failing gate blocks automerge. To accept a known advisory, add a reviewed, dated entry to `.github/dependency-exceptions.json` as described in `docs/design/dependency-threat-gate.md`.

## For maintainers

- Approve a held major update by ticking its box on the Dependency Dashboard issue.
- Lockfile maintenance runs weekly. Review its PR like any other update.
- Keep `pnpm-lock.yaml` in sync: Renovate regenerates it for frontend changes.

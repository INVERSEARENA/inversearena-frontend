.PHONY: dev dev-reset dev-seed test build migrate migrate-prod infra monitoring clean help \
        contracts-build contracts-deploy contracts-init-factory contracts-abi-check \
        contracts-coverage contracts-cost-bench \
        backend-dev backend-test frontend-dev deps-gate deps-gate-test \
        check-toolchain check-fast dev-doctor pr-triage-test \
        release-preflight release-preflight-test \
        docs-generate docs-check docs-build docs-links contracts-mutants

NETWORK ?= testnet
SOURCE  ?= deployer

## ── One-command local stack (#1647) ─────────────────────────────────────────

dev: ## One-command local stack: quickstart + contracts + seed + apps
	bash scripts/dev-stack.sh up

dev-reset: ## Clean slate: tear down the stack, wipe volumes and manifests
	bash scripts/dev-stack.sh reset

dev-seed: ## Re-seed open/active/finished/cancelled arenas
	npx tsx scripts/seed-arenas.ts

## ── Convenience shortcuts ──────────────────────────────────────────────────

test: ## Run all tests (backend + frontend)
	pnpm --filter @inversearena/rate-limit run build
	pnpm -r --filter inversearena-backend --filter inversearena-frontend --filter @inversearena/rate-limit run test

build: ## Build frontend and backend for production
	pnpm --filter inversearena-backend... --filter inversearena-frontend... run build

migrate: ## Apply pending Prisma migrations (development)
	pnpm --filter inversearena-backend run migrate:dev

migrate-prod: ## Apply migrations in production (no seed)
	pnpm --filter inversearena-backend exec prisma migrate deploy

infra: ## Start PostgreSQL + Redis via Docker Compose
	docker-compose up -d

monitoring: ## Start Prometheus + Grafana monitoring stack
	docker-compose -f backend/docker-compose.monitoring.yml up -d

clean: ## Remove build artifacts and node_modules
	rm -rf backend/dist frontend/.next
	rm -rf node_modules backend/node_modules frontend/node_modules packages/*/node_modules tools/*/node_modules scripts/node_modules docs-portal/node_modules

help: ## Show this help message
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' Makefile | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-18s\033[0m %s\n", $$1, $$2}'

check-toolchain: ## Run toolchain/devcontainer config tests
	node --test scripts/toolchain-config.test.mjs

check-fast: ## Run fast CI-mirror checks (skip missing deps)
	bash scripts/check-fast.sh all

dev-doctor: ## Validate local dev stack config without starting services
	bash scripts/dev-stack.sh --check

pr-triage-test: ## Run PR triage unit tests
	node --test scripts/pr-triage/*.test.mjs

DRY_RUN ?= 1
FORMAT  ?= json

release-preflight: ## Run release preflight across migrations, ABIs, config, and rollback (#1465)
	pnpm --filter inversearena-backend exec tsx ../scripts/release-preflight.ts --network $(NETWORK) --format $(FORMAT) $(if $(filter 1 true,$(DRY_RUN)),--dry-run,)

release-preflight-test: ## Run release preflight unit and integration tests (#1465)
	pnpm --filter inversearena-backend exec tsx --test ../scripts/release-preflight.test.ts

docs-generate: ## Generate OpenAPI and contract documentation artifacts
	node docs-portal/scripts/generate-openapi.mjs
	node docs-portal/scripts/generate-contract-docs.mjs

docs-check: ## Validate documentation portal sources and generators
	node --test docs-portal/scripts/*.test.mjs
	node docs-portal/scripts/generate-openapi.mjs --check
	node docs-portal/scripts/generate-contract-docs.mjs --check
	node docs-portal/scripts/check-links.mjs

docs-build: docs-check ## Build the static documentation portal
	node docs-portal/scripts/build.mjs

docs-links: ## Check documentation links only
	node docs-portal/scripts/check-links.mjs

## ── Contract targets ───────────────────────────────────────────────────────

contracts-build: ## Build + optimise all Soroban contracts
	cd contract && bash scripts/build.sh

contracts-deploy: ## Upload + deploy to $$NETWORK (default: testnet)
	cd contract && NETWORK=$(NETWORK) SOURCE=$(SOURCE) bash scripts/deploy.sh --network $(NETWORK) --source $(SOURCE)

contracts-init-factory: ## Initialise factory with arena WASM hash
	cd contract && NETWORK=$(NETWORK) SOURCE=$(SOURCE) bash scripts/init-factory.sh --network $(NETWORK) --source $(SOURCE)

contracts-abi-check: ## Verify ABI snapshots match compiled WASM
	cd contract && bash scripts/generate_abi_snapshots.sh --check

COVERAGE_NIGHTLY ?= nightly-2026-10-01
COVERAGE_IGNORE  := (^|/)(test|tests|[a-z_]+_tests?|storage_layout_fixture)\.rs$$

contracts-coverage: ## Per-crate line/branch coverage + thresholds (#1651)
	cd contract && cargo +$(COVERAGE_NIGHTLY) build --workspace --target wasm32v1-none --release
	cd contract && cargo +$(COVERAGE_NIGHTLY) llvm-cov --workspace --branch --no-report
	cd contract && cargo +$(COVERAGE_NIGHTLY) llvm-cov report --branch --html --output-dir target/coverage --ignore-filename-regex '$(COVERAGE_IGNORE)'
	cd contract && cargo +$(COVERAGE_NIGHTLY) llvm-cov report --branch --json --summary-only --output-path target/coverage/summary.json --ignore-filename-regex '$(COVERAGE_IGNORE)'
	node contract/scripts/coverage.mjs

contracts-cost-bench: ## Per-entry-point resource costs vs baseline (#1649)
	node contract/scripts/cost-bench.mjs

MUTATION_TOOLCHAIN ?= 1.96.0

contracts-mutants: ## Mutation-test critical contract guards (#1798)
	cd contract && RUSTUP_TOOLCHAIN=$(MUTATION_TOOLCHAIN) cargo build --workspace --target wasm32v1-none --release
	cd contract && RUSTUP_TOOLCHAIN=$(MUTATION_TOOLCHAIN) cargo mutants --in-place --no-shuffle
	node contract/scripts/mutations.mjs

## ── Granular targets (kept for backwards compatibility) ────────────────────

backend-dev: ## Start backend in watch mode
	pnpm --filter inversearena-backend run dev

backend-test: ## Run backend test suite
	pnpm --filter inversearena-backend run test

frontend-dev: ## Start Next.js dev server
	pnpm --filter inversearena-frontend run dev

## ── Supply chain (#1457) ───────────────────────────────────────────────────

deps-gate-test: ## Run the dependency threat gate's own tests
	node --test scripts/dependency-gate/gate.test.mjs

deps-gate: ## Audit all lockfiles and apply the dependency threat gate locally
	mkdir -p audit
	-pnpm audit --filter inversearena-backend --json > audit/backend.json
	-pnpm audit --filter inversearena-frontend --json > audit/frontend.json
	-cd contract && cargo audit --json > ../audit/contract.json
	node scripts/dependency-gate/gate.mjs --npm backend=audit/backend.json --pnpm frontend=audit/frontend.json --cargo contract=audit/contract.json --exceptions .github/dependency-exceptions.json

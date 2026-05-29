.PHONY: dev test build migrate migrate-prod infra monitoring clean help \
        contracts-build contracts-deploy contracts-init-factory contracts-abi-check \
        backend-dev backend-test frontend-dev

NETWORK ?= testnet
SOURCE  ?= deployer

## ── Convenience shortcuts ──────────────────────────────────────────────────

dev: ## Start frontend + backend in development mode
	cd backend && npm run dev &
	cd frontend && pnpm dev

test: ## Run all tests (backend + frontend)
	cd backend && npm run test:ci
	cd frontend && pnpm test --passWithNoTests

build: ## Build frontend and backend for production
	cd backend && npm run build
	cd frontend && pnpm build

migrate: ## Apply pending Prisma migrations (development)
	cd backend && npm run migrate:dev

migrate-prod: ## Apply migrations in production (no seed)
	cd backend && npx prisma migrate deploy

infra: ## Start PostgreSQL + Redis via Docker Compose
	docker-compose up -d

monitoring: ## Start Prometheus + Grafana monitoring stack
	docker-compose -f backend/docker-compose.monitoring.yml up -d

clean: ## Remove build artifacts and node_modules
	rm -rf backend/dist frontend/.next
	rm -rf backend/node_modules frontend/node_modules

help: ## Show this help message
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' Makefile | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-18s\033[0m %s\n", $$1, $$2}'

## ── Contract targets ───────────────────────────────────────────────────────

contracts-build: ## Build + optimise all Soroban contracts
	cd contract && bash scripts/build.sh

contracts-deploy: ## Upload + deploy to $$NETWORK (default: testnet)
	cd contract && NETWORK=$(NETWORK) SOURCE=$(SOURCE) bash scripts/deploy.sh --network $(NETWORK) --source $(SOURCE)

contracts-init-factory: ## Initialise factory with arena WASM hash
	cd contract && NETWORK=$(NETWORK) SOURCE=$(SOURCE) bash scripts/init-factory.sh --network $(NETWORK) --source $(SOURCE)

contracts-abi-check: ## Verify ABI snapshots match compiled WASM
	cd contract && bash scripts/generate_abi_snapshots.sh --check

## ── Granular targets (kept for backwards compatibility) ────────────────────

backend-dev: ## Start backend in watch mode
	cd backend && npm run dev

backend-test: ## Run backend test suite
	cd backend && npm test

frontend-dev: ## Start Next.js dev server
	cd frontend && pnpm dev

.PHONY: contracts-build contracts-deploy contracts-init-factory contracts-abi-check \
        backend-dev backend-test frontend-dev help

NETWORK ?= testnet
SOURCE  ?= deployer

help:
	@echo "InverseArena — top-level Makefile"
	@echo ""
	@echo "Contract targets (run from repo root, scripts operate inside contract/):"
	@echo "  make contracts-build           Build + optimise all Soroban contracts"
	@echo "  make contracts-deploy          Upload + deploy to \$$NETWORK (default: testnet)"
	@echo "  make contracts-init-factory    Initialise factory with arena WASM hash"
	@echo "  make contracts-abi-check       Verify ABI snapshots match compiled WASM"
	@echo ""
	@echo "Backend targets:"
	@echo "  make backend-dev               Start backend in watch mode"
	@echo "  make backend-test              Run backend test suite"
	@echo ""
	@echo "Frontend targets:"
	@echo "  make frontend-dev              Start Next.js dev server"
	@echo ""
	@echo "Options:"
	@echo "  NETWORK=testnet|mainnet        Target Stellar network (default: testnet)"
	@echo "  SOURCE=<identity>              Stellar CLI identity name (default: deployer)"

contracts-build:
	cd contract && bash scripts/build.sh

contracts-deploy:
	cd contract && NETWORK=$(NETWORK) SOURCE=$(SOURCE) bash scripts/deploy.sh --network $(NETWORK) --source $(SOURCE)

contracts-init-factory:
	cd contract && NETWORK=$(NETWORK) SOURCE=$(SOURCE) bash scripts/init-factory.sh --network $(NETWORK) --source $(SOURCE)

contracts-abi-check:
	cd contract && bash scripts/generate_abi_snapshots.sh --check

backend-dev:
	cd backend && npm run dev

backend-test:
	cd backend && npm test

frontend-dev:
	cd frontend && npm run dev

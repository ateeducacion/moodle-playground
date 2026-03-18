PORT ?= 8080
LOCAL_PORT ?= 8081
LOCAL_PHP ?= php84
DEFAULT_BRANCH ?= MOODLE_500_STABLE
JOBS ?= 2
# Auto-detect PHP 8.3 binary: check Homebrew paths (Apple Silicon, Intel), then system php
PHP_BIN ?= $(or \
  $(wildcard /opt/homebrew/opt/php@8.3/bin/php),\
  $(wildcard /usr/local/opt/php@8.3/bin/php),\
  $(shell command -v php 2>/dev/null))
export PHP_BIN

# Verify PHP 8.3 is available
check-php:
	@if [ -z "$(PHP_BIN)" ]; then \
		echo "ERROR: No PHP binary found. Install PHP 8.3 via: brew install php@8.3"; \
		exit 1; \
	fi
	@PHP_VER=$$($(PHP_BIN) -r 'echo PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION;' 2>/dev/null); \
	if [ "$$PHP_VER" != "8.3" ]; then \
		echo "ERROR: PHP 8.3 required but $(PHP_BIN) is PHP $$PHP_VER"; \
		echo "Install PHP 8.3 via: brew install php@8.3"; \
		exit 1; \
	fi
	@echo "Using PHP 8.3: $(PHP_BIN)"

.PHONY: deps build-worker bundle bundle-all bundle-all-pretty bundle-legacy prepare prepare-dev prepare-dev-pretty prepare-all serve up up-local clean reset check-php test lint format
.PHONY: bundle-MOODLE_404_STABLE bundle-MOODLE_405_STABLE bundle-MOODLE_500_STABLE bundle-MOODLE_501_STABLE bundle-main

deps:
	npm install

build-worker:
	npm run build:worker

# Fast prepare for local iteration: install deps and rebuild the worker bundle only.
prepare: deps build-worker

# Prepare a local dev runtime: worker + one Moodle branch bundle.
prepare-dev: deps build-worker bundle

# Prepare the local dev runtime with colorized parallel output for the worker and bundle.
prepare-dev-pretty: deps check-php
	npm run prepare:dev:pretty

# Full prepare for CI/release: worker + all Moodle bundles.
prepare-all: deps build-worker bundle-all

# Build one branch (defaults to DEFAULT_BRANCH, override with BRANCH=...).
bundle: check-php
	BRANCH=$${BRANCH:-$(DEFAULT_BRANCH)} npm run bundle

# Build all branches; use independent per-branch targets so recursive make can parallelize safely.
bundle-all: check-php
	$(MAKE) --no-print-directory -j $(JOBS) \
		bundle-MOODLE_404_STABLE \
		bundle-MOODLE_405_STABLE \
		bundle-MOODLE_500_STABLE \
		bundle-MOODLE_501_STABLE \
		bundle-main

# Colorized multi-branch build for local use.
bundle-all-pretty: deps check-php
	npm run bundle:all:pretty

# Legacy single-branch build via CHANNEL (backward compat)
bundle-legacy:
	CHANNEL=stable500 npm run bundle

# Per-branch bundle targets
bundle-MOODLE_404_STABLE:
	BRANCH=MOODLE_404_STABLE npm run bundle

bundle-MOODLE_405_STABLE:
	BRANCH=MOODLE_405_STABLE npm run bundle

bundle-MOODLE_500_STABLE:
	BRANCH=MOODLE_500_STABLE npm run bundle

bundle-MOODLE_501_STABLE:
	BRANCH=MOODLE_501_STABLE npm run bundle

bundle-main:
	BRANCH=main npm run bundle

serve:
	PORT=$(PORT) npm run serve

up: bundle-all-pretty serve

up-local: bundle
	./scripts/setup-local.sh $(LOCAL_PORT) $(LOCAL_PHP)

test:
	node --test tests/**/*.test.js

lint:
	npx @biomejs/biome check

format:
	npx @biomejs/biome check --fix

clean:
	rm -rf .cache
	rm -rf assets/moodle
	rm -f assets/manifests/latest.json
	rm -f assets/manifests/MOODLE_*.json
	rm -f assets/manifests/main.json
	touch assets/manifests/.gitkeep

reset: clean
	rm -rf dist

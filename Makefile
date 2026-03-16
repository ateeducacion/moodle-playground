PORT ?= 8080
LOCAL_PORT ?= 8081
LOCAL_PHP ?= php84
PHP_BIN ?= /opt/homebrew/opt/php@8.3/bin/php
export PHP_BIN

.PHONY: deps build-worker bundle bundle-legacy prepare serve up up-local clean reset
.PHONY: bundle-MOODLE_404_STABLE bundle-MOODLE_405_STABLE bundle-MOODLE_500_STABLE bundle-MOODLE_501_STABLE bundle-main

deps:
	npm install

build-worker:
	npm run build:worker

# Build all branches (default)
bundle: bundle-MOODLE_404_STABLE bundle-MOODLE_405_STABLE bundle-MOODLE_500_STABLE bundle-MOODLE_501_STABLE bundle-main

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

prepare: deps build-worker bundle

serve:
	python3 -m http.server $(PORT)

up: prepare serve

up-local: bundle
	./scripts/setup-local.sh $(LOCAL_PORT) $(LOCAL_PHP)

clean:
	rm -rf .cache
	rm -rf assets/moodle
	rm -f assets/manifests/latest.json
	rm -f assets/manifests/MOODLE_*.json
	rm -f assets/manifests/main.json
	touch assets/manifests/.gitkeep

reset: clean
	rm -rf dist

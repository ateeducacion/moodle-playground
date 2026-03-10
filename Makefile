ENV_FILE := $(if $(wildcard .env),.env,.env.dist)
NPM := npm
MOODLE_DIR := vendor/moodle
GH_PAGES_ASSETS_DIR := .dist/gh-pages/vendor/moodle

include $(ENV_FILE)

VERSION ?= $(MOODLE_DEFAULT_VERSION)
NORMALIZED_VERSION := $(subst -,_,$(subst .,_,$(VERSION)))
SOURCE_URL := $(MOODLE_SOURCE_URL_$(NORMALIZED_VERSION))

.PHONY: help env up clean deps fetch-moodle fetch-moodles gh-pages-assets build-runtime-env manifest

help:
	@echo "Targets:"
	@echo "  make deps   Install local npm dependencies"
	@echo "  make fetch-moodle VERSION=4.4  Download and extract one Moodle version into $(MOODLE_DIR)/<version>/"
	@echo "  make fetch-moodles  Download and extract every version in MOODLE_AVAILABLE_VERSIONS"
	@echo "  make gh-pages-assets  Copy extracted Moodle assets + manifest into $(GH_PAGES_ASSETS_DIR)"
	@echo "  make up     Generate lib/runtime-env.js and start the local HTTP server"
	@echo "  make clean  Remove local transient files"
	@echo "  make env    Regenerate lib/runtime-env.js from $(ENV_FILE)"

deps: package.json package-lock.json
	@$(NPM) install

fetch-moodle:
	@if [ -z "$(SOURCE_URL)" ]; then \
		echo "Missing MOODLE_SOURCE_URL_$(NORMALIZED_VERSION) in $(ENV_FILE)"; \
		exit 1; \
	fi; \
	ARCHIVE_DIR="$(MOODLE_DIR)/archives"; \
	VERSION_DIR="$(MOODLE_DIR)/$(VERSION)"; \
	TMP_DIR="$$(mktemp -d)"; \
	ARCHIVE_PATH="$$ARCHIVE_DIR/$(VERSION).zip"; \
	FILE_COUNT=0; \
	mkdir -p "$$ARCHIVE_DIR" "$$VERSION_DIR"; \
	rm -f "$$VERSION_DIR/moodle.tar" "$$VERSION_DIR/manifest.json"; \
	echo "Downloading Moodle $(VERSION) from $(SOURCE_URL)"; \
	curl -L --fail --output "$$ARCHIVE_PATH" "$(SOURCE_URL)" || exit 1; \
	unzip -q "$$ARCHIVE_PATH" -d "$$TMP_DIR"; \
	ROOT_DIR="$$(find "$$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)"; \
	if [ -z "$$ROOT_DIR" ]; then \
		echo "Could not find extracted Moodle root for $(VERSION)"; \
		rm -rf "$$TMP_DIR"; \
		exit 1; \
	fi; \
	FILE_COUNT="$$(find "$$ROOT_DIR" -type f | wc -l | tr -d ' ')"; \
	COPYFILE_DISABLE=1 tar --format=ustar -cf "$$VERSION_DIR/moodle.tar" -C "$$ROOT_DIR" .; \
	node ./scripts/build-moodle-manifest.mjs "$(VERSION)" "$$VERSION_DIR/manifest.json" "$$FILE_COUNT"; \
	rm -rf "$$TMP_DIR" "$$ARCHIVE_PATH"; \
	echo "Prepared extracted Moodle $(VERSION) in $$VERSION_DIR"

fetch-moodles:
	@set -e; \
	for version in $$(printf '%s' "$(MOODLE_AVAILABLE_VERSIONS)" | tr ',' ' '); do \
		$(MAKE) --no-print-directory fetch-moodle VERSION="$$version"; \
	done

env: lib/runtime-env.js

lib/runtime-env.js: $(ENV_FILE) Makefile
	@$(MAKE) --no-print-directory build-runtime-env

.PHONY: build-runtime-env
build-runtime-env:
	@mkdir -p lib
	@printf '%s\n' 'export const RUNTIME_ENV = Object.freeze({' > lib/runtime-env.js
	@printf '%s\n' '  APP_HOST: "$(APP_HOST)",' >> lib/runtime-env.js
	@printf '%s\n' '  APP_PORT: "$(APP_PORT)",' >> lib/runtime-env.js
	@printf '%s\n' '  MOODLE_ASSET_BASE_URL: "$(MOODLE_ASSET_BASE_URL)",' >> lib/runtime-env.js
	@printf '%s\n' '  MOODLE_AVAILABLE_VERSIONS: "$(MOODLE_AVAILABLE_VERSIONS)",' >> lib/runtime-env.js
	@printf '%s\n' '  MOODLE_ADMIN_USER: "$(MOODLE_ADMIN_USER)",' >> lib/runtime-env.js
	@printf '%s\n' '  MOODLE_DB_HOST: "$(MOODLE_DB_HOST)",' >> lib/runtime-env.js
	@printf '%s\n' '  MOODLE_DB_NAME: "$(MOODLE_DB_NAME)",' >> lib/runtime-env.js
	@printf '%s\n' '  MOODLE_DB_PASSWORD: "$(MOODLE_DB_PASSWORD)",' >> lib/runtime-env.js
	@printf '%s\n' '  MOODLE_DB_PREFIX: "$(MOODLE_DB_PREFIX)",' >> lib/runtime-env.js
	@printf '%s\n' '  MOODLE_DB_USER: "$(MOODLE_DB_USER)",' >> lib/runtime-env.js
	@printf '%s\n' '  MOODLE_DEFAULT_VERSION: "$(MOODLE_DEFAULT_VERSION)",' >> lib/runtime-env.js
	@printf '%s\n' '  MOODLE_MANIFEST_URL: "$(MOODLE_MANIFEST_URL)",' >> lib/runtime-env.js
	@printf '%s\n' '  PHP_WASM_VERSION: "$(PHP_WASM_VERSION)",' >> lib/runtime-env.js
	@printf '%s\n' '  PYTHON_BIN: "$(PYTHON_BIN)",' >> lib/runtime-env.js
	@printf '%s\n' '});' >> lib/runtime-env.js
	@echo "Generated lib/runtime-env.js from $(ENV_FILE)"

manifest:
	@mkdir -p "$(MOODLE_DIR)"
	@printf '{\n  "defaultVersion": "%s",\n  "versions": [' "$(MOODLE_DEFAULT_VERSION)" > "$(MOODLE_DIR)/manifest.json"
	@FIRST=1; \
	for version in $$(printf '%s' "$(MOODLE_AVAILABLE_VERSIONS)" | tr ',' ' '); do \
		if [ "$$FIRST" -eq 0 ]; then printf ',' >> "$(MOODLE_DIR)/manifest.json"; fi; \
		printf '\n    {"version":"%s","manifest":"./%s/manifest.json"}' "$$version" "$$version" >> "$(MOODLE_DIR)/manifest.json"; \
		FIRST=0; \
	done
	@printf '\n  ]\n}\n' >> "$(MOODLE_DIR)/manifest.json"
	@echo "Generated $(MOODLE_DIR)/manifest.json"

gh-pages-assets: fetch-moodles manifest
	@mkdir -p "$(GH_PAGES_ASSETS_DIR)"
	@rm -rf "$(GH_PAGES_ASSETS_DIR)"/*
	@for version in $$(printf '%s' "$(MOODLE_AVAILABLE_VERSIONS)" | tr ',' ' '); do \
		mkdir -p "$(GH_PAGES_ASSETS_DIR)/$$version"; \
		cp -R "$(MOODLE_DIR)/$$version"/. "$(GH_PAGES_ASSETS_DIR)/$$version/"; \
	done
	@cp "$(MOODLE_DIR)/manifest.json" "$(GH_PAGES_ASSETS_DIR)/manifest.json"
	@echo "Prepared GitHub Pages assets in $(GH_PAGES_ASSETS_DIR)"

up: deps lib/runtime-env.js $(MOODLE_DIR)/$(MOODLE_DEFAULT_VERSION)/manifest.json manifest
	@echo "Serving Moodle Playground on http://$(APP_HOST):$(APP_PORT)"
	@$(PYTHON_BIN) -m http.server $(APP_PORT) --bind $(APP_HOST)

$(MOODLE_DIR)/$(MOODLE_DEFAULT_VERSION)/manifest.json:
	@$(MAKE) --no-print-directory fetch-moodle VERSION="$(MOODLE_DEFAULT_VERSION)"

clean:
	@rm -rf __pycache__ .DS_Store
	@rm -rf .dist
	@rm -f lib/runtime-env.js
	@rm -f vendor/moodle.zip
	@rm -rf $(MOODLE_DIR)
	@find . -name '*.pyc' -delete
	@echo "Removed transient local files. Your .env was left untouched."

PORT ?= 8080
CHANNEL ?= stable500

.PHONY: deps sync bundle prepare serve run clean

deps:
	npm install

sync:
	npm run sync-browser-deps

bundle:
	CHANNEL=$(CHANNEL) ./scripts/build-moodle-bundle.sh

prepare: deps sync bundle

serve:
	python3 -m http.server $(PORT)

run: prepare serve

clean:
	rm -rf .cache
	rm -rf assets/moodle
	rm -f assets/manifests/latest.json

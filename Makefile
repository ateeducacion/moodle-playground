PORT ?= 8080
CHANNEL ?= stable500

.PHONY: deps sync prepare-runtime bundle prepare serve up clean reset

deps:
	npm install

sync:
	npm run sync-browser-deps

prepare-runtime: sync

bundle:
	CHANNEL=$(CHANNEL) npm run bundle

prepare: deps prepare-runtime bundle

serve:
	python3 -m http.server $(PORT)

up: prepare serve

clean:
	rm -rf .cache
	rm -rf assets/moodle
	rm -f assets/manifests/latest.json
	touch assets/manifests/.gitkeep

reset: clean
	rm -rf vendor

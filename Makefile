.PHONY: web-main web-all clean-web

web-main:
	bash src/makefile_wasm

# Backward-compatible alias for older scripts/CI invocations.
web-all: web-main

clean-web:
	rm -f web/earth-module.js web/earth-module.wasm

.PHONY: web-main clean-web

web-main:
	bash src/makefile_wasm

clean-web:
	rm -f web/earth-module.js web/earth-module.wasm

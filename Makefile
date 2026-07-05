.PHONY: test typecheck check install uninstall

test:
	bun test

typecheck:
	bun x tsc --noEmit

check: test typecheck

install:
	mkdir -p $(HOME)/.config/amp/plugins
	ln -sf $(PWD)/autoresearch.ts $(HOME)/.config/amp/plugins/amp-autoresearch.ts

uninstall:
	rm -f $(HOME)/.config/amp/plugins/amp-autoresearch.ts

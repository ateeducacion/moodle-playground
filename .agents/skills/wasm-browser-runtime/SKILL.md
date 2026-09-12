---
name: wasm-browser-runtime
description: Debug browser-playground WASM memory, core extraction, filesystem journaling, service-worker routing, or crash recovery.
metadata:
  author: playgrounds
  version: "2.0"
---

# Browser WASM runtime

For storage roots, cache policy, and recovery details, use the host repository's
[runtime reference](../../references/php-wasm-runtime.md), especially its storage
section. Keep that reference outside the installed skill so updates cannot replace
local policy. If absent, inspect the host's persistence and recovery implementation.

## Memory and extraction

MEMFS files occupy JS heap; PHP reads can copy bytes into WASM linear memory.
Account for compressed buffers, decoder state, extracted files, and linear memory
when diagnosing peaks. Streaming extraction avoids a whole uncompressed archive
allocation but still retains the final filesystem. Keep integrity checks and
archive-path validation; incomplete extraction must not be recorded as installed.

A NODEFS spike mounts host files without the browser's copying cost. Measure the
current browser path instead of treating a successful Node run or old bundle size
as a memory guarantee. Read configured limits; do not prescribe one universal
memory ceiling or introduce OPFS as an automatic fallback.

## Journaling and recovery

MEMFS is volatile, but these hosts restore mutable state through IndexedDB journals.
Read the actual journal roots, exclusions, and namespace rules before editing:
OPcache policy and mutable paths differ between applications. A tab scope in
sessionStorage does not imply IndexedDB is physically deleted when the tab closes.

Normalize journal operations before hydrating file contents, including rename
destinations. Preserve flush failures and resilient replay behavior; a failed
checkpoint must not silently turn into a successful one. Clean boot must restart
journaling after clearing data.

A WASM trap may leave MEMFS readable. Recovery still needs bounded snapshots and
coherent DB/upload checkpoints. Follow the existing fallback when a checkpoint
fails; do not restore a newer DB over older files. Keep restart guards and
GET/HEAD-only replay; never replay a mutating request automatically.

## Routing and verification

Trace shell → remote host → Service Worker → PHP worker. Preserve scoped runtime
paths and app base paths, redirects, query strings, HTML-escaped URLs, and forms.
Keep cache keys isolated according to the host's scope/runtime/build policy.
Use existing protocol definitions rather than illustrative message shapes.

A Service Worker's default maximum scope is its script directory; keep the classic
bundle at the app root. Rebuild worker imports and clear stale worker caches for
browser verification. Resetting data is not a code-cache refresh. Check affected
routing under root and subpath hosting; check cold boot and reload for storage edits.

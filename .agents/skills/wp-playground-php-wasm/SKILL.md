---
name: wp-playground-php-wasm
description: Change PHP-WASM runtime creation, request adapters, ini configuration, or outbound PHP networking in browser playgrounds.
metadata:
  author: playgrounds
  version: "2.0"
---

# PHP-WASM integration

For application-specific settings, read the PHP section of the host repository's
[runtime reference](../../references/php-wasm-runtime.md). This reference stays
outside the installed skill. If using the skill in a new repository without it,
inspect the local loader and request adapter; do not borrow another app's defaults.

## Runtime and request boundaries

`loadWebRuntime()` yields a runtime ID; `new PHP(runtimeId)` creates the instance.
Reuse the host's loader so filesystem setup, networking, and journaling stay wired
together. Check installed package versions/source for exact API contracts.

Distinguish the raw PHP instance from the host's compatibility wrapper. Our
playgrounds expose it as `php._php`; adapter conveniences such as `analyzePath`
are not necessarily raw PHP methods. Check callers before changing either API.

Each execution resets PHP globals and PDO connections. Persistent application
state must be in files/database/cookies, not PHP objects between requests. SQLite
must remain a MEMFS file rather than `:memory:`. Use the host's HTTP request path
for login so its cookie jar captures `Set-Cookie`.

Preserve method, body, status, headers, PATH_INFO, and CGI variables when adapting
requests. A front controller's route is not necessarily a literal filesystem path.
Keep deployment subpaths in the server variables used to construct application URLs.

## Configuration and networking

Set ini entries through `setPhpIniEntries` on the raw instance. Inspect both loader
and bootstrap overrides to determine effective settings. Do not assume a project
php.ini is read, or copy another app's prepend, extension list, or memory limits.
Application CLI detection differs; use the local provisioning wrapper.

PHP curl is not controlled by a JS `globalThis.fetch` blocker. Preserve the
configured PHP networking bridge, generated CA, and proxy/allowlist policy.
Browser archive downloads and PHP requests are separate paths; test the one being
changed. When `tcpOverFetch` is active, keep CA file settings aligned with its CA.

Use the existing error/result handling and adapter tests. Rebuild the worker for
browser verification after changing its imports. Check login or outbound requests
in the actual browser when those paths change; a Node spike alone is insufficient.

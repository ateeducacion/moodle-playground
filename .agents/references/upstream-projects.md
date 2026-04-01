# Upstream Project References

This project builds on top of two key upstream projects. Agents should consult them
when investigating bugs, understanding API surfaces, or looking for implementation patterns.

## WordPress Playground (`@php-wasm/*`)

- **Repository**: https://github.com/WordPress/wordpress-playground
- **What it provides**: The PHP WebAssembly runtime (`@php-wasm/web`, `@php-wasm/universal`)
  that powers the PHP execution layer. This includes the WASM-compiled PHP 8.3 binary,
  the `PHP` class API (`php.run()`, `php.writeFile()`, `php.readFileAsBuffer()`,
  `php.mkdir()`, `php.isDir()`, `setPhpIniEntries()`, etc.), and the web worker
  infrastructure for running PHP in the browser.
- **When to look there**:
  - Understanding PHP instance lifecycle, request execution, and `PHPRequestHandler`
  - Debugging WASM-level crashes, memory limits, or file descriptor exhaustion
  - Checking available PHP extensions in the WASM build
  - Understanding `php.ini` handling (hardcoded path `/internal/shared/php.ini`)
  - Investigating Emscripten MEMFS behavior and filesystem APIs
  - Looking for known issues with the PHP WASM runtime (e.g., [#1137](https://github.com/WordPress/wordpress-playground/issues/1137))
- **Key difference**: WordPress Playground runs WordPress; we adapted the same PHP runtime
  to run Moodle and Omeka S. The `php-compat.js` layer in this repo bridges the WP
  Playground PHP API to our request/response model.
  A particularly important upstream feature is `tcpOverFetch`: PHP thinks it is opening
  raw TCP/TLS sockets, but `@php-wasm/web` actually translates that traffic into browser
  `fetch()` calls. This only solves the PHP/WASM side of networking; browser-side CORS
  constraints still exist and may require a proxy fallback.

## Omeka S Playground

- **Repository**: https://github.com/ateeducacion/omeka-s-playground
- **What it is**: The first playground we built using this architecture. Moodle Playground
  follows the same product shape and many of the same patterns. Omeka S Playground was the
  proving ground where the shell/remote/sw/worker architecture was designed.
- **When to look there**:
  - Understanding the original design intent behind the shell → remote → sw → worker flow
  - Comparing how a simpler PHP application (Omeka S) handles the same challenges
    (service worker routing, subpath deployment, ZIP extraction, config generation)
  - Finding patterns that were proven in Omeka S before being adapted for Moodle
  - Debugging service worker or iframe communication issues — the pattern originated there
- **Key differences from Moodle Playground**:
  - Omeka S uses MySQL via PGlite; Moodle uses SQLite (deprecated PDO driver)
  - Omeka S has a simpler install flow; Moodle requires a pre-built install snapshot
  - Moodle Playground adds blueprints, crash recovery, and plugin installation support
  - Moodle's codebase is significantly larger, requiring more aggressive caching and
    memory management strategies

## How to Use These References

1. **Before inventing a solution**, check if WordPress Playground or Omeka S Playground
   already solved the same problem — especially for WASM runtime issues, service worker
   routing, and PHP-in-browser quirks.
2. **When debugging `@php-wasm/*` APIs**, read the WordPress Playground source code for
   the authoritative behavior — our `php-compat.js` is a thin adapter, not a replacement.
3. **When adding new architecture**, check if Omeka S Playground established a pattern
   first. Consistency across playgrounds reduces maintenance burden.

---
name: wp-playground-php-wasm
description: Change Moodle Playground PHP runtime creation, php-compat request conversion, php.ini settings, or outbound PHP networking.
metadata:
  author: moodle-playground
  version: "1.0"
---

# WordPress Playground & @php-wasm Runtime Expert

## Upstream repository

**Source**: https://github.com/WordPress/wordpress-playground

Dependency versions are recorded in `package.json` and `package-lock.json`.
Read installed upstream source when checking exact API behavior.

## PHP instance lifecycle

### Creation

`src/runtime/php-loader.js` obtains a runtime ID from `loadWebRuntime()`, constructs
`new PHP(runtimeId)`, applies ini entries, then wraps that instance in `php-compat.js`.
The runtime ID itself is not a PHP instance. Reuse the loader so networking,
filesystem initialization, and persistence are configured together.

### Execution model

Each `php.run()` call is a **complete PHP lifecycle**:

1. PHP globals are initialized fresh
2. `$_SERVER`, `$_GET`, `$_POST`, etc. are populated from the request object
3. The PHP script executes to completion (or fatal error)
4. All PHP state is destroyed (variables, open handles, PDO connections)
5. Output (stdout) and headers are captured and returned

**Critical implication**: PHP state does NOT persist between `php.run()` calls. This is
why the SQLite database must be a file in MEMFS, not `:memory:` — a `:memory:` DB would
be empty on the next request because the PDO connection is closed and reopened.

### Request format

```javascript
const response = await php.run({
    scriptPath: '/www/moodle/admin/index.php',
    method: 'GET',
    headers: { 'Host': 'localhost', 'Cookie': 'MoodleSession=abc123' },
    url: '/admin/index.php?redirect=0',
    body: '',  // For POST requests
});
```

The response object:
```javascript
{
    httpStatusCode: 200,
    headers: { 'content-type': ['text/html; charset=utf-8'], ... },
    text: '<html>...',        // Output as string
    bytes: Uint8Array,        // Output as bytes
    errors: '',               // stderr output
    exitCode: 0,              // 0 = success
}
```

### CLI mode execution

For provisioning (blueprint steps), we use CLI mode:

```javascript
const response = await php.run({
    scriptPath: '/tmp/script.php',
    // No method, url, or headers — runs as CLI
});
```

The PHP script should define `CLI_SCRIPT` before requiring Moodle's `config.php`:

```php
define('CLI_SCRIPT', true);
require('/www/moodle/config.php');
// ... Moodle API calls
```

## Filesystem API

The PHP instance exposes Emscripten's MEMFS through these methods:

| Method | Description |
|--------|-------------|
| `php.writeFile(path, data)` | Write string or Uint8Array to path |
| `php.readFileAsText(path)` | Read file as UTF-8 string |
| `php.readFileAsBuffer(path)` | Read file as Uint8Array |
| `php.mkdir(path)` | Create directory (parent must exist) |
| `php.mkdirTree(path)` | Create directory and all parents |
| `php.isDir(path)` | Check if path is a directory |
| `php.fileExists(path)` | Check if path exists (file or directory) |
| `php.unlink(path)` | Delete a file |
| `php.listFiles(path)` | List directory contents |
| `php.analyzePath(path)` | Compat-wrapper emulation, not a raw `PHP` method |

**Important**: Except for the compat-only `analyzePath`, these operate on the raw `PHP` instance (`php._php` in our compat layer),
not on the compatibility wrapper. The compat wrapper (`php-compat.js`) exposes a subset
and adds error handling.

**MEMFS characteristics**:
- All data lives in JavaScript heap memory (RAM)
- MEMFS itself is volatile; this project separately journals `/persist` to IndexedDB for reloads
- No size limits beyond available heap memory
- File operations are synchronous and fast (no I/O wait)
- Permissions are emulated but not enforced
- Symlinks are supported but rarely used

## php.ini configuration

**Critical**: WP Playground hardcodes the ini path to `/internal/shared/php.ini`. Writing
a separate `php.ini` file anywhere else has NO effect. All settings must go through:

```javascript
import { setPhpIniEntries } from '@php-wasm/universal';

setPhpIniEntries(php, {
    'date.timezone': 'UTC',
    'memory_limit': '512M',
    'max_execution_time': '0',
    'display_errors': 'Off',
    'session.save_path': '/tmp/moodle/sessions',
    'upload_tmp_dir': '/tmp',
    // ... etc
});
```

This must be called **before** any `php.run()` — settings applied after execution has
started may not take effect for all directives.

Our project applies ini settings in `src/runtime/php-loader.js` during runtime creation,
with timezone overrides applied later in `src/runtime/bootstrap.js` after blueprint parsing.

## The compatibility layer (php-compat.js)

Our `src/runtime/php-compat.js` wraps the raw WP Playground `PHP` instance to provide:

1. **Request conversion**: Browser `Request` → PHP request object format
2. **Response conversion**: PHP response → browser `Response`
3. **`$_SERVER` population**: `SCRIPT_NAME`, `PHP_SELF`, `REQUEST_URI`, `PATH_INFO`,
   `SCRIPT_FILENAME`, `DOCUMENT_ROOT`, `HTTP_*` headers
4. **Base path injection**: Prepends URL base path (e.g., `/moodle-playground`) to
   `SCRIPT_NAME` and `PHP_SELF` for correct Moodle URL construction
5. **PATH_INFO resolution**: Splits URLs like `/theme/styles.php/boost/123/all` into
   script path (`/theme/styles.php`) and PATH_INFO (`/boost/123/all`)
6. **MIME type detection**: Returns correct Content-Type for static files
7. **`analyzePath` emulation**: Wraps Emscripten's `FS.analyzePath()` for path checking

### PATH_INFO handling (critical)

Moodle uses PATH_INFO extensively for resource URLs:
- `/theme/styles.php/boost/1234567890/all` — CSS delivery
- `/theme/javascript.php/1234567890/boost/head` — JS delivery
- `/pluginfile.php/1/mod_resource/content/0/file.pdf` — File serving

`resolveScriptPath()` in `php-compat.js` must:
1. Walk the URL path segments
2. Find the first segment ending in `.php`
3. Split into script path (before and including `.php`) and PATH_INFO (after)

Without this, `isPhpScript()` returns false (URL doesn't end in `.php`) → 404.

## Known issues and upstream bugs

### File descriptor exhaustion
- PHP WASM has a limited number of file descriptors (~1024)
- Long sessions with many requests can exhaust them
- Manifests as `RuntimeError: unreachable` or WASM traps
- Our crash recovery system detects and handles this
- See: https://github.com/WordPress/wordpress-playground/issues/1137

### Memory limits
- WASM linear memory has a growth limit (~2-4 GB depending on browser)
- Large Moodle operations (file uploads, backup/restore) can hit this
- OOM manifests as `RuntimeError: memory access out of bounds`
- No way to free WASM memory — must restart the runtime

### Extension availability
Available in PHP 8.3 WASM: `sqlite3`, `pdo_sqlite`, `dom`, `simplexml`, `xml`,
`mbstring`, `openssl`, `intl`, `iconv`, `zlib`, `zip`, `phar`, `curl`, `gd`,
`fileinfo`, `xmlreader`, `xmlwriter`.

**NOT available**: `sodium` (despite being listed in some docs). The OpenSSL fallback
patch in `patches/shared/lib/classes/encryption.php` handles encryption needs.

### Session handling
- Sessions use file-based storage in MEMFS (`/tmp/moodle/sessions/`)
- Session data persists across `php.run()` calls (files survive in MEMFS)
- Session IDs are generated by PHP and tracked via `MoodleSession` cookie
- After crash recovery, sessions are invalidated — a new admin session must be created

## Debugging tips

1. **Check `response.errors`** — stderr output often contains PHP warnings/notices
2. **Check `response.exitCode`** — non-zero means PHP script failed
3. **Enable PHP display_errors** — set `display_errors=On` in ini entries for debugging
4. **Use `?debug=true`** — forces `DEBUG_DEVELOPER` and `display_errors=1` at boot
5. **Read upstream source** — when `php-compat.js` behavior is unclear, check the
   `@php-wasm/universal` source at `node_modules/@php-wasm/universal/`
6. **MEMFS inspection** — use `php.listFiles()` and `php.readFileAsText()` to inspect
   the virtual filesystem during debugging

## Repository-specific pitfalls

These areas have repeatedly caused regressions and require extra care:

### php.ini configuration
- WP Playground hardcodes `/internal/shared/php.ini` via `PHP_INI_PATH` in `@php-wasm/universal`
- Writing a separate php.ini file (e.g., `/www/php.ini`) has NO effect — PHP never reads it
- All php.ini settings must be applied via `setPhpIniEntries()` from `@php-wasm/universal`
- Settings are applied in `src/runtime/php-loader.js` during runtime creation
- Blueprint timezone overrides are applied in `src/runtime/bootstrap.js` after provisioning

### Outbound PHP networking
- `tcpOverFetch` must stay enabled in `src/runtime/php-loader.js`; disabling it removes
  the generated CA and breaks all outbound HTTP(S) from PHP.
- `openssl.cafile` and `curl.cainfo` must point to `/internal/shared/playground-ca.pem`
  whenever `tcpOverFetch` is active.
- `playground.config.json` should use `phpCorsProxyUrl` for PHP networking fallback and
  `addonProxyUrl` for browser-side ZIP downloads; the old generic `proxyUrl` alias should
  not be reintroduced.
- `MOODLE_PLAYGROUND_PROXY_URL` must stay scope-aware (`/playground/<scope>/<runtime>/...`);
  plugins that choose the same-origin proxy path must not derive proxy URLs from
  `$CFG->wwwroot` alone.
- The generated CA must avoid explicit `keyUsage`, `nsCertType`, and SAN IP
  extensions: the upstream ASN.1 encoder mis-encodes them (PR #1926-style profile).
- The Service Worker endpoint `__playground_proxy__` must preserve the incoming query
  string and forward it to the configured external proxy unchanged.
- The supported and tested paths for GitHub feeds/assets from PHP are now both:
  direct HTTPS through `phpCorsProxyUrl` and the same-origin proxy endpoint.

### php-compat.js CGI variables
- CGI environment variables such as `HTTP_USER_AGENT`, `SCRIPT_NAME`, and `SCRIPT_FILENAME` are critical
- The Request-to-PHPRequest conversion must preserve headers, method, and body
- The PHPResponse-to-Response conversion must preserve status codes and headers
- **URL base path in `$_SERVER`**: `SCRIPT_NAME`, `PHP_SELF`, and `REQUEST_URI` must include
  the URL base path (e.g., `/moodle-playground` on GitHub Pages). Moodle's
  `setup_get_remote_url()` in `lib/setuplib.php` constructs `$FULLME`/`$FULLSCRIPT` by
  extracting **only the scheme+host** from `$CFG->wwwroot` and combining it with
  `$_SERVER['SCRIPT_NAME']`. If SCRIPT_NAME lacks the base path, all redirect URLs lose
  the subpath, causing infinite redirect loops on subpath deployments.

## Checklist for php-wasm-touching changes

- [ ] Does the change work with the stateless `php.run()` model? (no PHP state persists)
- [ ] Are ini settings applied via `setPhpIniEntries()`, not a php.ini file?
- [ ] Does PATH_INFO resolution handle the URL pattern correctly?
- [ ] Are `$_SERVER` variables correct, including base path prefix?
- [ ] Does the change account for `sodium` not being available?
- [ ] Could this hit file descriptor limits in long sessions?
- [ ] Is the raw PHP instance (`php._php`) used for filesystem ops, not the wrapper?

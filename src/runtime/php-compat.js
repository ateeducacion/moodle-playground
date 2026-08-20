/**
 * Compatibility layer that wraps WordPress Playground's PHP instance
 * to match the API surface expected by bootstrap.js, php-worker.js,
 * bootstrap-fs.js, and moodle-loader.js.
 */

import { __private__dont__use } from "@php-wasm/universal";

const DEFAULT_WEB_ROOT = "/www/moodle";

/**
 * Convert a native Request object to a normalized request descriptor.
 */
async function normalizeRequest(requestOrUrl) {
  if (!(requestOrUrl instanceof Request)) {
    return requestOrUrl;
  }

  const request = requestOrUrl;
  const url = new URL(request.url);
  const result = {
    method: request.method || "GET",
    url: url.pathname + url.search,
    headers: {},
  };

  for (const [key, value] of request.headers.entries()) {
    result.headers[key] = value;
  }

  if (!["GET", "HEAD"].includes(request.method)) {
    // Always try to read the body for non-GET/HEAD requests.
    // Check request.body first (ReadableStream), but also try arrayBuffer()
    // as a fallback — some browsers may have body bytes without a stream.
    let bodyBuffer;
    try {
      bodyBuffer = await request.arrayBuffer();
    } catch {
      bodyBuffer = new ArrayBuffer(0);
    }
    result.body = new Uint8Array(bodyBuffer);
    result.headers["content-length"] = String(result.body.byteLength);
    // TODO: remove debug logging after Firefox AJAX fix is verified
    if (result.body.byteLength === 0 && request.method === "POST") {
      console.warn(
        `[php-compat] POST ${url.pathname} has empty body! request.body=${request.body}, content-type=${result.headers["content-type"] || "none"}`,
      );
    }
  }

  return result;
}

/**
 * Decode a `PATH_INFO` value pulled from a URL pathname into the form PHP
 * expects from a CGI environment.  Apache and nginx URL-decode PATH_INFO
 * before exposing it to PHP (per RFC 3875 §4.1.5), so a request URI of
 * `/draftfile.php/5/user/draft/123/The%20Adventures` exposes PATH_INFO
 * as `/5/user/draft/123/The Adventures` — not as the raw `%20`-encoded
 * form.  `decodeURIComponent` throws on malformed sequences; fall back
 * to the raw value rather than blowing up the entire request.
 */
function decodePathInfo(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Resolve the PHP script path and PATH_INFO from a URL pathname.
 * Handles directory requests by appending index.php.
 * Handles PATH_INFO (e.g., /theme/styles.php/boost/123/all).
 */
function resolveScriptPath(pathname, webRoot) {
  // Check for PATH_INFO: split at ".php/" to find the script and the extra path
  const phpIdx = pathname.indexOf(".php/");
  if (phpIdx >= 0) {
    const scriptPath = `${webRoot}${pathname.substring(0, phpIdx + 4)}`;
    const pathInfo = pathname.substring(phpIdx + 4);
    return { scriptPath, pathInfo };
  }

  let scriptPath = `${webRoot}${pathname}`;

  // Directory requests → index.php
  if (scriptPath.endsWith("/")) {
    scriptPath += "index.php";
  }

  return { scriptPath, pathInfo: "" };
}

const MIME_TYPES = {
  css: "text/css; charset=utf-8",
  gif: "image/gif",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xml: "application/xml; charset=utf-8",
};

/**
 * Check if a path is a PHP script (should be executed) or a static file (served directly).
 */
function isPhpScript(path) {
  return path.endsWith(".php");
}

/**
 * Get MIME type for a file extension.
 */
function getMimeType(path) {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  return MIME_TYPES[ext] || "application/octet-stream";
}

// The Fetch spec forbids a body on these statuses; PHP legitimately emits 204
// and 304 (conditional GETs, no-content replies) and constructing a Response
// with bytes for them throws and blanks the whole page.
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * Convert a PHPResponse to a native Response object.
 *
 * Optional `extraHeaders` (object of name → string) are appended after the
 * PHP-emitted headers — used to surface diagnostic metadata (exit code,
 * stderr) when the underlying script exited non-zero but still produced a
 * well-formed CGI response.
 */
function phpResponseToResponse(phpResponse, extraHeaders) {
  const headers = new Headers();
  if (phpResponse.headers) {
    for (const [key, values] of Object.entries(phpResponse.headers)) {
      for (const value of values) {
        // Skip headers with an invalid name/value rather than letting a single
        // malformed header (Headers.append() throws "Invalid name") abort the
        // entire response — which would blank the whole page.
        try {
          headers.append(key, value);
        } catch (error) {
          try {
            console.warn(
              `[php-compat] skipping invalid response header "${key}": ${error?.message || error}`,
            );
          } catch {}
        }
      }
    }
  }
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      if (value !== undefined && value !== null && value !== "") {
        headers.set(key, value);
      }
    }
  }

  const status = phpResponse.httpStatusCode;
  return new Response(
    NULL_BODY_STATUSES.has(status) ? null : phpResponse.bytes,
    {
      status,
      headers,
    },
  );
}

/**
 * Encode a string for safe transport in an HTTP header value.
 * Uses base64 so arbitrary bytes (newlines, non-ASCII) survive the header
 * grammar that browsers and Service Workers enforce.
 */
function encodeHeaderValue(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  if (typeof btoa === "function") {
    return btoa(binary);
  }
  // Node fallback for tests.
  return Buffer.from(binary, "binary").toString("base64");
}

/**
 * Decide whether a PHPResponse that accompanied a non-zero exit code still
 * represents a real, browser-deliverable HTTP response (e.g. Moodle's
 * `repository_ajax.php` emitting a JSON error and exiting with code 1).
 *
 * The discriminator is intentionally conservative: only pass through when
 *   1. PHP wrote at least one CGI header (so the response has a real
 *      Content-Type) AND
 *   2. the body bytes are non-empty.
 *
 * If either is missing, the response is treated as a true failure (segfault,
 * fatal parse error before output, etc.) and the diagnostic wrapper still
 * runs in `php-worker.js`.
 */
export function shouldPassThroughFailedPhpResponse(phpResponse) {
  if (!phpResponse || typeof phpResponse !== "object") {
    return false;
  }
  const headers = phpResponse.headers;
  if (!headers || typeof headers !== "object") {
    return false;
  }
  let hasHeader = false;
  for (const key of Object.keys(headers)) {
    const values = headers[key];
    if (Array.isArray(values) ? values.length > 0 : Boolean(values)) {
      hasHeader = true;
      break;
    }
  }
  if (!hasHeader) {
    return false;
  }
  const bytes = phpResponse.bytes;
  if (
    !bytes ||
    typeof bytes.byteLength !== "number" ||
    bytes.byteLength === 0
  ) {
    return false;
  }
  return true;
}

/**
 * True when an error thrown by `@php-wasm/universal` represents a PHP script
 * that ran to completion but exited non-zero. Such errors carry the parsed
 * `PHPResponse` on `.response` and `"request"` on `.source`.
 */
function isPhpExecutionFailure(error) {
  if (!error || typeof error !== "object") {
    return false;
  }
  if (error.name === "PHPExecutionFailureError") {
    return true;
  }
  if (error.source === "request" && error.response) {
    return true;
  }
  return false;
}

export const __testing = {
  encodeHeaderValue,
  isPhpExecutionFailure,
  phpResponseToResponse,
  shouldPassThroughFailedPhpResponse,
};

/**
 * Wraps a WordPress Playground PHP instance with the compatibility API
 * expected by the Moodle Playground codebase.
 *
 * Uses php.run() directly with explicit $_SERVER and scriptPath for full
 * control over the CGI environment. This avoids issues with PHPRequestHandler's
 * URL rewriting, directory resolution, and cookie handling.
 */
export function wrapPhpInstance(
  php,
  { syncFs = null, absoluteUrl = "http://localhost:8080", webRoot } = {},
) {
  const resolvedWebRoot = webRoot || DEFAULT_WEB_ROOT;
  const emscriptenModule = php[__private__dont__use];
  const parsedAbsoluteUrl = new URL(absoluteUrl);
  // URL base path for subpath deployments (e.g., "/moodle-playground" on GH Pages).
  // Moodle's setup_get_remote_url() uses SCRIPT_NAME to construct $FULLME/$FULLSCRIPT,
  // combining only the scheme+host from $CFG->wwwroot with $_SERVER['SCRIPT_NAME'].
  // Without this prefix, redirect URLs lose the subpath on GitHub Pages deployments.
  const urlBasePath = parsedAbsoluteUrl.pathname.replace(/\/+$/u, "");
  const cookies = new Map();

  return {
    /**
     * Send an HTTP request through PHP.
     * Accepts a native Request object or a PHPRequest-shaped object.
     * Returns a native Response object.
     */
    async request(requestOrUrl) {
      const req = await normalizeRequest(requestOrUrl);
      const urlPath = req.url || "/";
      const qIdx = urlPath.indexOf("?");
      const pathname = qIdx >= 0 ? urlPath.substring(0, qIdx) : urlPath;
      const queryString = qIdx >= 0 ? urlPath.substring(qIdx + 1) : "";
      const { scriptPath, pathInfo } = resolveScriptPath(
        pathname,
        resolvedWebRoot,
      );

      // Serve static files (images, CSS, JS, etc.) directly from the filesystem
      // without executing them through PHP.
      if (!isPhpScript(scriptPath)) {
        try {
          const data = php.readFileAsBuffer(scriptPath);
          return new Response(data, {
            status: 200,
            headers: { "content-type": getMimeType(scriptPath) },
          });
        } catch {
          return new Response("Not Found", { status: 404 });
        }
      }

      // Return 404 for PHP scripts that don't exist in the filesystem
      if (!php.fileExists(scriptPath)) {
        return new Response("Not Found", { status: 404 });
      }

      // Build $_SERVER to match what Moodle expects from a CGI environment.
      // SCRIPT_NAME and PHP_SELF must include the URL base path (e.g.,
      // "/moodle-playground/admin/index.php" not just "/admin/index.php")
      // so that Moodle's setup_get_remote_url() constructs correct absolute URLs.
      const scriptRelative =
        scriptPath.substring(resolvedWebRoot.length) || "/index.php";
      const serverVars = {
        DOCUMENT_ROOT: resolvedWebRoot,
        SCRIPT_FILENAME: scriptPath,
        SCRIPT_NAME: urlBasePath + scriptRelative,
        PHP_SELF: urlBasePath + scriptRelative,
        REQUEST_URI: urlBasePath + urlPath,
        REQUEST_METHOD: req.method || "GET",
        QUERY_STRING: queryString,
        SERVER_NAME: parsedAbsoluteUrl.hostname,
        SERVER_PORT:
          parsedAbsoluteUrl.port ||
          (parsedAbsoluteUrl.protocol === "https:" ? "443" : "80"),
        SERVER_PROTOCOL: "HTTP/1.1",
        HTTP_HOST: parsedAbsoluteUrl.host,
        HTTP_USER_AGENT: "MoodlePlayground/1.0 (WASM)",
        REMOTE_ADDR: "127.0.0.1",
        HTTPS: parsedAbsoluteUrl.protocol === "https:" ? "on" : "",
        // PATH_INFO must arrive at PHP URL-DECODED, matching the CGI spec
        // (RFC 3875 §4.1.5) and the behaviour of Apache/nginx + mod_php.
        // Moodle's `get_file_argument()` reads `$_SERVER['PATH_INFO']` as-is
        // and uses the result directly as the relative file path; if we leave
        // the `%20` literals in, the parsed filename ends up containing
        // literal "%20" instead of spaces, the SHA1 pathnamehash computed
        // from it does not match what `create_file_from_pathname()` stored,
        // and `draftfile.php` / `pluginfile.php` answer 404 for any file
        // whose name contains a space, comma, accent, etc.  REQUEST_URI
        // intentionally stays raw — that's how Apache exposes it.
        PATH_INFO: pathInfo ? decodePathInfo(pathInfo) : "",
      };

      // Add HTTP_* headers from the request.
      // Per CGI spec, Content-Type and Content-Length use CONTENT_TYPE and
      // CONTENT_LENGTH without the HTTP_ prefix (RFC 3875 §4.1.3/4.1.2).
      const headers = req.headers || {};
      for (const [key, value] of Object.entries(headers)) {
        const lowerKey = key.toLowerCase();
        if (lowerKey === "host") continue;
        if (lowerKey === "content-type") {
          serverVars.CONTENT_TYPE = value;
        } else if (lowerKey === "content-length") {
          serverVars.CONTENT_LENGTH = value;
        } else {
          const envKey = `HTTP_${key.toUpperCase().replace(/-/g, "_")}`;
          serverVars[envKey] = value;
        }
      }

      // Inject stored cookies
      if (cookies.size > 0) {
        const cookieHeader = [...cookies.entries()]
          .map(([k, v]) => `${k}=${v}`)
          .join("; ");
        serverVars.HTTP_COOKIE = serverVars.HTTP_COOKIE
          ? `${serverVars.HTTP_COOKIE}; ${cookieHeader}`
          : cookieHeader;
      }

      // Inject cookie jar into headers so php.run() populates $_COOKIE
      const mergedHeaders = { ...headers };
      if (serverVars.HTTP_COOKIE) {
        mergedHeaders.cookie = serverVars.HTTP_COOKIE;
      }

      // Set cwd to the script's directory so relative paths (e.g.,
      // admin/index.php's `file_exists('../config.php')`) resolve correctly,
      // matching what a real web server does for CGI scripts.
      const scriptDir =
        scriptPath.substring(0, scriptPath.lastIndexOf("/")) || "/";
      try {
        // emscriptenModule may be a Promise in WP Playground — await it.
        const module = await emscriptenModule;
        if (module?.FS?.chdir) {
          module.FS.chdir(scriptDir);
        }
      } catch {
        // Non-fatal — directory might not exist yet during early boot.
      }

      // @php-wasm/universal throws `PHPExecutionFailureError` whenever the
      // PHP process exits with a non-zero status — even when the script
      // legitimately wrote a full CGI response first (Moodle's AJAX error
      // handlers do this; e.g. repository_ajax.php prints a JSON error
      // payload then calls die() / exits 1).  Without this guard the
      // worker treated those responses as crashes and overwrote them with
      // an HTML diagnostic page, producing "Unexpected token '<'" errors
      // in any browser code that expected JSON.
      //
      // Catch that specific failure, and if the attached PHPResponse looks
      // like a real CGI response (headers + body), deliver it untouched.
      // Stderr is preserved via console.warn and a custom response header
      // so debuggability isn't lost.
      let phpResponse;
      let nonZeroExitCode = 0;
      let nonZeroExitErrors = "";
      try {
        phpResponse = await php.run({
          scriptPath,
          method: req.method || "GET",
          headers: mergedHeaders,
          body: req.body,
          $_SERVER: serverVars,
          relativeUri: urlPath,
        });
      } catch (error) {
        if (
          isPhpExecutionFailure(error) &&
          shouldPassThroughFailedPhpResponse(error.response)
        ) {
          phpResponse = error.response;
          nonZeroExitCode = Number(phpResponse.exitCode) || 1;
          nonZeroExitErrors = String(phpResponse.errors || "");
          if (typeof console !== "undefined" && console.warn) {
            console.warn(
              `[playground] PHP exited ${nonZeroExitCode} for ${urlPath} but emitted a CGI response; passing it through.${
                nonZeroExitErrors ? `\nstderr: ${nonZeroExitErrors}` : ""
              }`,
            );
          }
        } else {
          throw error;
        }
      }

      // Remember cookies from Set-Cookie headers (case-insensitive lookup —
      // WP Playground may return "set-cookie" or "Set-Cookie" depending on version)
      const setCookieKey = Object.keys(phpResponse.headers || {}).find(
        (k) => k.toLowerCase() === "set-cookie",
      );
      const setCookieHeaders = setCookieKey
        ? phpResponse.headers[setCookieKey]
        : [];
      for (const header of setCookieHeaders) {
        const parts = header.split(";")[0];
        const eqIndex = parts.indexOf("=");
        if (eqIndex > 0) {
          const name = parts.substring(0, eqIndex).trim();
          const value = parts.substring(eqIndex + 1).trim();
          if (
            value === "" ||
            header.toLowerCase().includes("max-age=0") ||
            header.toLowerCase().includes("expires=thu, 01 jan 1970")
          ) {
            cookies.delete(name);
          } else {
            cookies.set(name, value);
          }
        }
      }

      let extraHeaders;
      if (nonZeroExitCode !== 0) {
        extraHeaders = {
          "x-playground-php-exit-code": String(nonZeroExitCode),
        };
        if (nonZeroExitErrors) {
          extraHeaders["x-playground-php-stderr"] =
            encodeHeaderValue(nonZeroExitErrors);
        }
      }

      const response = phpResponseToResponse(phpResponse, extraHeaders);

      if (syncFs) {
        await syncFs();
      }

      return response;
    },

    /**
     * Check whether a path exists and whether it is a directory.
     */
    async analyzePath(path) {
      try {
        const exists = php.fileExists(path);
        if (!exists) {
          return { exists: false };
        }
        const isFolder = php.isDir(path);
        return {
          exists: true,
          object: { isFolder, mode: isFolder ? 0o40755 : 0o100644 },
        };
      } catch {
        return { exists: false };
      }
    },

    async mkdir(path) {
      php.mkdir(path);
    },

    async writeFile(path, data) {
      php.writeFile(path, data);
    },

    async readFile(path) {
      return php.readFileAsBuffer(path);
    },

    /**
     * Synchronously serve a static (non-.php) file from MEMFS, or return null
     * when the caller must fall back to the normal queued request() path:
     * the target is a PHP script (incl. `.php/PATH_INFO` routes), a path
     * traversal, or the file is missing.
     *
     * This is the same MEMFS read as the static branch of request() (above),
     * exposed so the worker can answer it WITHOUT waiting in the serial PHP
     * request queue. Safe to call while a php.run() is suspended:
     * readFileAsBuffer is a pure-JS Emscripten MEMFS read (no WASM re-entry)
     * and the worker is single-threaded, so reads are atomic w.r.t. PHP
     * writes. moodledata is NOT URL-addressable (resolveScriptPath only maps
     * under webRoot), so dataroot files never take this path.
     *
     * @returns {{status:number, headers:object, bytes:Uint8Array}|null}
     */
    serveStaticSync(urlPath) {
      const path = String(urlPath || "/");
      const qIdx = path.indexOf("?");
      const pathname = qIdx >= 0 ? path.substring(0, qIdx) : path;
      // Defense in depth: never let a traversal escape webRoot. The SW/Request
      // URL normalization already collapses dot segments, so this is
      // belt-and-braces.
      if (pathname.includes("/../")) {
        return null;
      }
      const { scriptPath } = resolveScriptPath(pathname, resolvedWebRoot);
      // .php (and .php/PATH_INFO, which resolveScriptPath maps to a .php
      // script) must keep going through the queued PHP execution path.
      if (isPhpScript(scriptPath)) {
        return null;
      }
      try {
        const bytes = php.readFileAsBuffer(scriptPath);
        return {
          status: 200,
          headers: { "content-type": getMimeType(scriptPath) },
          bytes,
        };
      } catch {
        // Missing file → fall back to the queue (preserves boot-race /
        // mid-install semantics; never reply 404 from the fast path).
        return null;
      }
    },

    /**
     * Run inline PHP code. Returns a PHPResponse with .text and .errors.
     */
    async run(code) {
      return php.run({ code });
    },

    /**
     * The Emscripten module for low-level FS access.
     */
    get binary() {
      return emscriptenModule;
    },

    addEventListener(type, handler) {
      php.addEventListener(type, handler);
    },

    removeEventListener(type, handler) {
      php.removeEventListener(type, handler);
    },

    /**
     * Inject a cookie into the internal cookie jar so that subsequent
     * request() calls include it automatically.
     */
    setCookie(name, value) {
      if (value === "" || value == null) {
        cookies.delete(name);
      } else {
        cookies.set(name, value);
      }
    },

    get _php() {
      return php;
    },
  };
}

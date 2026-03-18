/**
 * Compatibility layer that wraps WordPress Playground's PHP instance
 * to match the API surface expected by bootstrap.js, php-worker.js,
 * bootstrap-fs.js, moodle-loader.js, and vfs-mount.js.
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

/**
 * Convert a PHPResponse to a native Response object.
 */
function phpResponseToResponse(phpResponse) {
  const headers = new Headers();
  if (phpResponse.headers) {
    for (const [key, values] of Object.entries(phpResponse.headers)) {
      for (const value of values) {
        headers.append(key, value);
      }
    }
  }

  return new Response(phpResponse.bytes, {
    status: phpResponse.httpStatusCode,
    headers,
  });
}

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
        PATH_INFO: pathInfo || "",
      };

      // Add HTTP_* headers from the request
      const headers = req.headers || {};
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === "host") continue;
        const envKey = `HTTP_${key.toUpperCase().replace(/-/g, "_")}`;
        serverVars[envKey] = value;
        // Also set content-type/content-length without HTTP_ prefix
        if (key.toLowerCase() === "content-type") {
          serverVars.CONTENT_TYPE = value;
        }
        if (key.toLowerCase() === "content-length") {
          serverVars.CONTENT_LENGTH = value;
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

      const phpResponse = await php.run({
        scriptPath,
        method: req.method || "GET",
        headers: mergedHeaders,
        body: req.body,
        $_SERVER: serverVars,
        relativeUri: urlPath,
      });

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

      const response = phpResponseToResponse(phpResponse);

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
     * Run inline PHP code. Returns a PHPResponse with .text and .errors.
     */
    async run(code) {
      return php.run({ code });
    },

    /**
     * The Emscripten module for low-level FS access (vfs-mount.js).
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

/**
 * Tests for the pure helper functions in php-compat.js.
 * We can't import them directly (they're not exported), so we test
 * the logic by reimplementing the patterns and verifying them.
 *
 * The critical functions are: resolveScriptPath, isPhpScript, getMimeType.
 * Since these are not exported, we replicate them here to test the logic
 * that the module depends on.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Replicate the pure functions from php-compat.js for testing
function resolveScriptPath(pathname, webRoot) {
  const phpIdx = pathname.indexOf(".php/");
  if (phpIdx >= 0) {
    const scriptPath = `${webRoot}${pathname.substring(0, phpIdx + 4)}`;
    const pathInfo = pathname.substring(phpIdx + 4);
    return { scriptPath, pathInfo };
  }

  let scriptPath = `${webRoot}${pathname}`;
  if (scriptPath.endsWith("/")) {
    scriptPath += "index.php";
  }

  return { scriptPath, pathInfo: "" };
}

function isPhpScript(path) {
  return path.endsWith(".php");
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

function getMimeType(path) {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  return MIME_TYPES[ext] || "application/octet-stream";
}

describe("resolveScriptPath", () => {
  const webRoot = "/www/moodle";

  it("resolves a simple PHP script", () => {
    const result = resolveScriptPath("/admin/index.php", webRoot);
    assert.strictEqual(result.scriptPath, "/www/moodle/admin/index.php");
    assert.strictEqual(result.pathInfo, "");
  });

  it("resolves directory request to index.php", () => {
    const result = resolveScriptPath("/", webRoot);
    assert.strictEqual(result.scriptPath, "/www/moodle/index.php");
    assert.strictEqual(result.pathInfo, "");
  });

  it("resolves PATH_INFO after .php/", () => {
    const result = resolveScriptPath(
      "/theme/styles.php/boost/123/all",
      webRoot,
    );
    assert.strictEqual(result.scriptPath, "/www/moodle/theme/styles.php");
    assert.strictEqual(result.pathInfo, "/boost/123/all");
  });

  it("resolves another PATH_INFO pattern", () => {
    const result = resolveScriptPath(
      "/theme/image.php/boost/block_myoverview/123/courses",
      webRoot,
    );
    assert.strictEqual(result.scriptPath, "/www/moodle/theme/image.php");
    assert.strictEqual(result.pathInfo, "/boost/block_myoverview/123/courses");
  });

  it("resolves static files without PATH_INFO", () => {
    const result = resolveScriptPath("/lib/jquery/jquery.min.js", webRoot);
    assert.strictEqual(
      result.scriptPath,
      "/www/moodle/lib/jquery/jquery.min.js",
    );
    assert.strictEqual(result.pathInfo, "");
  });

  it("handles subdirectory with trailing slash", () => {
    const result = resolveScriptPath("/admin/", webRoot);
    assert.strictEqual(result.scriptPath, "/www/moodle/admin/index.php");
  });

  it("works with 5.1+ webRoot", () => {
    const result = resolveScriptPath("/admin/index.php", "/www/moodle/public");
    assert.strictEqual(result.scriptPath, "/www/moodle/public/admin/index.php");
  });
});

describe("isPhpScript", () => {
  it("returns true for .php files", () => {
    assert.strictEqual(isPhpScript("/www/moodle/admin/index.php"), true);
  });

  it("returns false for JS files", () => {
    assert.strictEqual(isPhpScript("/www/moodle/lib/jquery.js"), false);
  });

  it("returns false for CSS files", () => {
    assert.strictEqual(isPhpScript("/www/moodle/theme/styles.css"), false);
  });

  it("returns false for paths without extension", () => {
    assert.strictEqual(isPhpScript("/www/moodle/admin"), false);
  });
});

describe("getMimeType", () => {
  it("returns correct type for CSS", () => {
    assert.strictEqual(getMimeType("styles.css"), "text/css; charset=utf-8");
  });

  it("returns correct type for JS", () => {
    assert.strictEqual(
      getMimeType("app.js"),
      "application/javascript; charset=utf-8",
    );
  });

  it("returns correct type for PNG", () => {
    assert.strictEqual(getMimeType("logo.png"), "image/png");
  });

  it("returns correct type for SVG", () => {
    assert.strictEqual(getMimeType("icon.svg"), "image/svg+xml");
  });

  it("returns correct type for WOFF2", () => {
    assert.strictEqual(getMimeType("font.woff2"), "font/woff2");
  });

  it("returns octet-stream for unknown extension", () => {
    assert.strictEqual(getMimeType("file.xyz"), "application/octet-stream");
  });

  it("handles paths with directories", () => {
    assert.strictEqual(
      getMimeType("/theme/boost/styles.css"),
      "text/css; charset=utf-8",
    );
  });
});

// Replicate the helper from php-compat.js — same approach as the other
// reimplemented helpers in this file.
function decodePathInfo(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

describe("decodePathInfo", () => {
  it("URL-decodes percent-encoded spaces", () => {
    assert.strictEqual(
      decodePathInfo(
        "/5/user/draft/123/The%20Adventures%20of%20Sherlock%20Holmes",
      ),
      "/5/user/draft/123/The Adventures of Sherlock Holmes",
    );
  });

  it("URL-decodes commas, parentheses, and accents", () => {
    assert.strictEqual(
      decodePathInfo("/5/user/draft/123/Walter%20Benington%2C%201914.jpg"),
      "/5/user/draft/123/Walter Benington, 1914.jpg",
    );
    assert.strictEqual(
      decodePathInfo("/5/user/draft/123/foto%20(1).jpg"),
      "/5/user/draft/123/foto (1).jpg",
    );
    assert.strictEqual(
      decodePathInfo("/5/user/draft/123/jos%C3%A9.txt"),
      "/5/user/draft/123/josé.txt",
    );
  });

  it("returns ASCII paths unchanged", () => {
    assert.strictEqual(
      decodePathInfo("/5/user/draft/123/omeka-logo.png"),
      "/5/user/draft/123/omeka-logo.png",
    );
  });

  it("falls back to the raw value on malformed percent-encoding", () => {
    // `decodeURIComponent("%E0%A4%A")` throws; the helper must not bubble
    // that up — leaving the request to die is worse than serving a
    // PATH_INFO with a stray %.
    assert.strictEqual(decodePathInfo("/bad%E0%A4%A"), "/bad%E0%A4%A");
  });

  it("returns empty string for empty input", () => {
    assert.strictEqual(decodePathInfo(""), "");
  });
});

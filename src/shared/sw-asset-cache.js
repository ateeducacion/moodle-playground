const STATIC_EXTENSION =
  /\.(css|js|mjs|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|ico|webp|map)$/iu;
const PHP_ASSET =
  /^\/(theme\/(?:styles|image|font|fonts)\.php|lib\/(?:javascript|requirejs|yui)\.php)\//u;

// See docs/architecture/adr/ADR-0034-public-immutable-esm-cache.md.
export function isCacheableScopedAssetPath(requestPath) {
  const path = requestPath.split("?")[0];
  // Ambiguous encodings always take the ordinary PHP path.
  if (path.includes("%") || path.includes("\\")) return false;
  // Purges can select development AMD; caching its -1 URL serves stale plugins.
  if (
    /^\/lib\/(?:requirejs|javascript)\.php\//u.test(path) &&
    !/^\/lib\/(?:requirejs|javascript)\.php\/[1-9]\d*\//u.test(path)
  )
    return false;
  if (path.startsWith("/r.php/")) {
    if (requestPath.includes("?")) return false;
    const match = path.match(/^\/r\.php\/core\/esm\/([1-9]\d*)\/(.+)$/u);
    if (!match || !Number.isSafeInteger(Number(match[1]))) return false;
    return match[2]
      .split("/")
      .every((segment) => segment && segment !== "." && segment !== "..");
  }
  // A protected PHP response is not a static file just because PATH_INFO ends in .js.
  return (
    PHP_ASSET.test(path) ||
    (!/\.php(?:\/|$)/iu.test(path) && STATIC_EXTENSION.test(path))
  );
}

export function isCacheableScopedAssetResponse(requestPath, response) {
  if (!isCacheableScopedAssetPath(requestPath) || !response.ok) return false;
  const type = response.headers.get("content-type") || "";
  if (/text\/html|application\/xhtml\+xml/iu.test(type)) return false;
  const directives = (response.headers.get("cache-control") || "")
    .toLowerCase()
    .split(",")
    .map((value) => value.split("=")[0].trim());
  if (
    directives.some((value) =>
      ["private", "no-store", "no-cache"].includes(value),
    )
  )
    return false;
  if (!requestPath.startsWith("/r.php/")) return true;
  return (
    response.status === 200 &&
    /^(?:text|application)\/javascript(?:;|$)/iu.test(type) &&
    directives.includes("public") &&
    directives.includes("immutable") &&
    // Defense in depth only: fetched response headers may hide Set-Cookie.
    // Admission relies on the public ESM controller/path, never this check alone.
    !response.headers.has("set-cookie") &&
    !(response.headers.get("vary") || "")
      .split(",")
      .some((value) => value.trim() === "*")
  );
}

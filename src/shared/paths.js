export function getBasePath() {
  const segments = window.location.pathname.split("/").filter(Boolean);

  if (segments.length <= 1) {
    return "/";
  }

  return `/${segments.slice(0, -1).join("/")}/`;
}

export function joinBasePath(basePath, path) {
  const cleanBase = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const cleanPath = path.startsWith("/") ? path.slice(1) : path;
  return `${cleanBase}/${cleanPath}`.replace(/\/{2,}/gu, "/");
}

export function resolveRemoteUrl(
  scopeId,
  runtimeId,
  path = "/",
  {
    phpVersion,
    moodleBranch,
    addonProxyUrl,
    phpCorsProxyUrl,
    debug,
    profile,
    bundleFormat,
  } = {},
) {
  const url = new URL("./remote.html", window.location.href);
  url.searchParams.set("scope", scopeId);
  url.searchParams.set("runtime", runtimeId);
  url.searchParams.set("path", path);
  if (phpVersion) {
    url.searchParams.set("phpVersion", phpVersion);
  }
  if (moodleBranch) {
    url.searchParams.set("moodleBranch", moodleBranch);
  }
  if (addonProxyUrl) {
    url.searchParams.set("addonProxyUrl", addonProxyUrl);
  }
  if (phpCorsProxyUrl) {
    url.searchParams.set("phpCorsProxyUrl", phpCorsProxyUrl);
  }
  if (debug) {
    url.searchParams.set("debug", debug);
  }
  if (profile) {
    url.searchParams.set("profile", profile);
  }
  if (bundleFormat) {
    url.searchParams.set("bundle-format", bundleFormat);
  }
  return url;
}

export function buildScopedSitePath(scopeId, runtimeId, path = "/") {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return joinBasePath(
    getBasePath(),
    `playground/${scopeId}/${runtimeId}${normalized}`,
  ).replace(/\/{2,}/gu, "/");
}

function djb2(value) {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

// Stable identity of the blueprint a URL points at. The shell compares it across
// reloads to decide whether to reset the persisted env: a different blueprint
// source => different key => clean boot; the same source => same key => keep the
// persisted data. Keyed by the source (URL value / inline param), not the
// resolved object, so it stays stable across reloads.
export function blueprintSourceKey(href = window.location.href) {
  const params = new URL(href).searchParams;
  const url = params.get("blueprint-url");
  if (url) {
    return `url:${url}`;
  }
  const inline = params.get("blueprint") ?? params.get("blueprint-data");
  if (inline) {
    return `inline:${djb2(inline)}`;
  }
  return "default";
}

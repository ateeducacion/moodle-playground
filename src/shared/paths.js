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

export function resolveRemoteUrl(scopeId, runtimeId, path = "/") {
  const url = new URL("./remote.html", window.location.href);
  url.searchParams.set("scope", scopeId);
  url.searchParams.set("runtime", runtimeId);
  url.searchParams.set("path", path);
  return url;
}

export function buildScopedSitePath(scopeId, runtimeId, path = "/") {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return joinBasePath(getBasePath(), `playground/${scopeId}/${runtimeId}${normalized}`).replace(/\/{2,}/gu, "/");
}

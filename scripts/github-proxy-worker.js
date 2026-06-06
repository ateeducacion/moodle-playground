// Cloudflare Worker that acts as a GitHub proxy for archive files and Atom feeds.
//
// Supports two modes:
//
// 1. Generic proxy mode (legacy): ?url={full_url}
//    Proxies supported direct URLs with CORS headers. This includes ZIP downloads,
//    GitHub-hosted text/binary resources, FacturaScripts plugin pages,
//    omeka.org / dev.omeka.org resources (plugin/module pages and downloads), and
//    Nextcloud / ownCloud public share links (/s/{token}[/download]) on any host.
//
// 2. GitHub proxy mode: ?repo={owner/repo}[&branch=...][&pr=...][&commit=...][&release=...][&asset=...][&atom=...][&path=...]
//    Builds the correct GitHub URL from semantic parameters and proxies the response.
//    With &path={file} it serves a single raw file at the given ref (default
//    branch when no ref is given) with CORS — e.g. a blueprint.json living in
//    the repo. The ref travels as a query param, so refs with slashes
//    (feat/x) are handled losslessly.
//
// Environment variables (optional):
//   GITHUB_TOKEN – A GitHub personal access token to raise API rate limits from 60 to 5000 req/hour.

const GITHUB_API = "https://api.github.com";
const GITHUB_BASE = "https://github.com";
const GITHUB_RAW = "https://raw.githubusercontent.com";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonResponse(
        { error: "Method not allowed. Only GET and HEAD are supported." },
        405,
      );
    }

    const params = new URL(request.url).searchParams;

    // Legacy generic proxy mode
    if (params.has("url")) {
      return handleGenericProxy(params.get("url"), request);
    }

    // GitHub proxy mode
    if (params.has("repo")) {
      return handleGitHubProxy(params, env);
    }

    // If the request accepts HTML (browser), serve the landing page.
    // Otherwise (curl, fetch, etc.) return JSON usage info.
    const acceptHeader = request.headers.get("Accept") || "";

    if (acceptHeader.includes("text/html")) {
      return new Response(landingPageHtml(new URL(request.url).origin), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return jsonResponse(
      {
        error: "Missing parameters. Provide either ?url= or ?repo=.",
        usage: {
          generic: "?url={full_url}",
          branch: "?repo={owner/repo}[&branch={branch}]",
          pr: "?repo={owner/repo}&pr={number}",
          commit: "?repo={owner/repo}&commit={sha}",
          release: "?repo={owner/repo}&release={tag}",
          asset: "?repo={owner/repo}&release={tag}&asset={filename}",
          raw_file: "?repo={owner/repo}&path={path}[&branch={branch}]",
          atom_releases: "?repo={owner/repo}&atom=releases",
          atom_tags: "?repo={owner/repo}&atom=tags",
        },
      },
      400,
    );
  },
};

// ---------------------------------------------------------------------------
// GitHub proxy mode
// ---------------------------------------------------------------------------

async function handleGitHubProxy(params, env) {
  const repo = params.get("repo");

  if (!repo?.includes("/")) {
    return jsonResponse({ error: "Invalid repo format. Use owner/repo." }, 400);
  }

  // Raw file at a ref (e.g. a blueprint.json checked into the repo), served
  // with CORS. The ref is a query param, so refs with slashes work. Resolves
  // the ref from branch/ref/commit/release, falling back to the default branch.
  if (params.has("path")) {
    const ref =
      params.get("branch") ||
      params.get("ref") ||
      params.get("commit") ||
      params.get("release") ||
      (await getDefaultBranch(repo, env)) ||
      "main";
    return proxyRawFile(repo, ref, params.get("path"));
  }

  // Atom feeds
  if (params.has("atom")) {
    return handleAtomFeed(repo, params.get("atom"));
  }

  // Release asset
  if (params.has("release") && params.has("asset")) {
    return handleReleaseAsset(
      repo,
      params.get("release"),
      params.get("asset"),
      env,
    );
  }

  // Full release ZIP
  if (params.has("release")) {
    return proxyGitHubZip(
      `${GITHUB_BASE}/${repo}/archive/refs/tags/${params.get("release")}.zip`,
    );
  }

  // Specific commit
  if (params.has("commit")) {
    return proxyGitHubZip(
      `${GITHUB_BASE}/${repo}/archive/${params.get("commit")}.zip`,
    );
  }

  // Pull request
  if (params.has("pr")) {
    return handlePullRequest(repo, params.get("pr"), env);
  }

  // Branch (or default branch)
  const branch = params.get("branch");

  if (branch) {
    return proxyGitHubZip(
      `${GITHUB_BASE}/${repo}/archive/refs/heads/${branch}.zip`,
    );
  }

  // No branch specified – resolve the default branch via the API
  const defaultBranch = await getDefaultBranch(repo, env);

  if (defaultBranch) {
    return proxyGitHubZip(
      `${GITHUB_BASE}/${repo}/archive/refs/heads/${defaultBranch}.zip`,
    );
  }

  // The API could not resolve the default branch (rate-limited, or the
  // GITHUB_TOKEN is blocked for this repo by an org fine-grained-PAT policy).
  // Fall back to the conventional branch names instead of failing outright.
  return proxyFirstAvailableZip([
    `${GITHUB_BASE}/${repo}/archive/refs/heads/main.zip`,
    `${GITHUB_BASE}/${repo}/archive/refs/heads/master.zip`,
  ]);
}

// Proxies the first candidate archive URL that resolves successfully, returning
// the last failing response if none do. Used as a no-API fallback for
// default-branch resolution.
async function proxyFirstAvailableZip(urls) {
  let lastResponse = null;

  for (const url of urls) {
    const response = await proxyGitHubZip(url);

    if (response.status < 400) {
      return response;
    }

    lastResponse = response;
  }

  return lastResponse;
}

// ---------------------------------------------------------------------------
// Atom feeds
// ---------------------------------------------------------------------------

async function handleAtomFeed(repo, type) {
  const validTypes = ["releases", "tags"];

  if (!validTypes.includes(type)) {
    return jsonResponse(
      { error: `Invalid atom type. Use one of: ${validTypes.join(", ")}` },
      400,
    );
  }

  const url = `${GITHUB_BASE}/${repo}/${type}.atom`;

  try {
    // Atom feeds live on github.com; re-validate any redirect hop against the
    // GitHub host allowlist instead of blindly following it.
    const upstream = await fetchWithValidatedRedirects(
      url,
      { method: "GET", headers: { "User-Agent": "github-proxy-worker" } },
      isGitHubDirectProxyUrl,
    );

    if (!upstream.ok) {
      return jsonResponse(
        {
          error: "Upstream server returned an error.",
          status: upstream.status,
          statusText: upstream.statusText,
        },
        502,
      );
    }

    const headers = new Headers();

    applyCorsHeaders(headers);
    headers.set("Content-Type", "application/atom+xml; charset=utf-8");
    headers.set("Cache-Control", "public, max-age=300");

    return new Response(upstream.body, { status: 200, headers });
  } catch (error) {
    if (error instanceof RedirectBlockedError) {
      return redirectBlockedResponse(error);
    }
    return jsonResponse(
      { error: "Failed to fetch Atom feed.", details: error.message },
      502,
    );
  }
}

// ---------------------------------------------------------------------------
// Raw file resolution
// ---------------------------------------------------------------------------

// Fetches a single raw file from raw.githubusercontent.com and returns it with
// CORS headers. Used to serve a repo's blueprint.json (or any small text/JSON
// asset) cross-origin to the browser playground without inlining it in the URL.
async function proxyRawFile(repo, ref, rawPath) {
  const path = String(rawPath).replace(/^\/+/, "");
  const url = `${GITHUB_RAW}/${repo}/${ref}/${path}`;

  try {
    // raw.githubusercontent.com serves directly (no redirect in practice), but
    // validate any redirect hop against the GitHub host allowlist just in case.
    const upstream = await fetchWithValidatedRedirects(
      url,
      { method: "GET", headers: { "User-Agent": "github-proxy-worker" } },
      (candidate) =>
        candidate.hostname === "raw.githubusercontent.com" ||
        isGitHubDirectProxyUrl(candidate),
    );

    if (!upstream.ok) {
      return jsonResponse(
        {
          error: "Upstream server returned an error.",
          status: upstream.status,
          statusText: upstream.statusText,
        },
        upstream.status === 404 ? 404 : 502,
      );
    }

    const headers = new Headers();

    applyCorsHeaders(headers);
    headers.set(
      "Content-Type",
      path.toLowerCase().endsWith(".json")
        ? "application/json; charset=utf-8"
        : upstream.headers.get("Content-Type") || "text/plain; charset=utf-8",
    );
    headers.set("Cache-Control", "public, max-age=60");

    return new Response(upstream.body, { status: 200, headers });
  } catch (error) {
    if (error instanceof RedirectBlockedError) {
      return redirectBlockedResponse(error);
    }
    return jsonResponse(
      { error: "Failed to fetch raw file.", details: error.message },
      502,
    );
  }
}

// ---------------------------------------------------------------------------
// Pull request resolution
// ---------------------------------------------------------------------------

async function handlePullRequest(repo, prNumber, env) {
  const apiUrl = `${GITHUB_API}/repos/${repo}/pulls/${prNumber}`;
  const data = await githubApiRequest(apiUrl, env);

  if (!data?.head?.sha) {
    return jsonResponse(
      { error: `Could not resolve PR #${prNumber}. Check that it exists.` },
      502,
    );
  }

  return proxyGitHubZip(`${GITHUB_BASE}/${repo}/archive/${data.head.sha}.zip`);
}

// ---------------------------------------------------------------------------
// Release asset resolution
// ---------------------------------------------------------------------------

async function handleReleaseAsset(repo, tag, assetName, env, request = null) {
  // A release asset's browser_download_url is deterministic:
  //   https://github.com/{repo}/releases/download/{tag}/{assetName}
  // and 302s to the asset CDN with no API call. We query the API first only to
  // surface a helpful "available_assets" list on a genuine typo — but we must
  // NOT hard-depend on it. The API can be rate-limited, or the worker's
  // GITHUB_TOKEN can be blocked for the repo (e.g. an org fine-grained-PAT
  // policy 404s a public repo), which would otherwise turn every legitimate
  // download into a 502 JSON body.
  const directUrl = `${GITHUB_BASE}/${repo}/releases/download/${encodeURIComponent(
    tag,
  )}/${encodeURIComponent(assetName)}`;

  const apiUrl = `${GITHUB_API}/repos/${repo}/releases/tags/${tag}`;
  const data = await githubApiRequest(apiUrl, env);

  // API reachable: validate the asset name and use its canonical download URL.
  if (data?.assets) {
    const asset = data.assets.find(
      (a) => a.name.toLowerCase() === assetName.toLowerCase(),
    );

    if (!asset) {
      const available = data.assets.map((a) => a.name);

      return jsonResponse(
        {
          error: `Asset "${assetName}" not found in release "${tag}".`,
          available_assets: available,
        },
        404,
      );
    }

    return proxyGitHubZip(asset.browser_download_url, {
      request,
      downloadFilename: asset.name,
    });
  }

  // API unavailable/blocked: fall back to the deterministic direct URL so the
  // download still works without any api.github.com call.
  return proxyGitHubZip(directUrl, { request, downloadFilename: assetName });
}

// ---------------------------------------------------------------------------
// Default branch resolution
// ---------------------------------------------------------------------------

async function getDefaultBranch(repo, env) {
  const data = await githubApiRequest(`${GITHUB_API}/repos/${repo}`, env);

  return data ? data.default_branch : null;
}

// ---------------------------------------------------------------------------
// GitHub API helper
// ---------------------------------------------------------------------------

async function githubApiRequest(url, env) {
  const headers = {
    "User-Agent": "github-proxy-worker",
    Accept: "application/vnd.github+json",
  };

  const token = env?.GITHUB_TOKEN;

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const response = await fetch(url, { headers });

    if (!response.ok) {
      return null;
    }

    return response.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Redirect-safe fetch
// ---------------------------------------------------------------------------

// Maximum number of redirect hops to follow before giving up.
const MAX_REDIRECT_HOPS = 5;

class RedirectBlockedError extends Error {
  constructor(message, blockedUrl) {
    super(message);
    this.name = "RedirectBlockedError";
    this.blockedUrl = blockedUrl;
  }
}

// Fetches a URL while validating every redirect hop instead of blindly
// following them. Using redirect:"follow" would let an allowlisted host (or one
// with an open redirect / attacker-influenced content) 302 us into a private or
// otherwise unauthorized target (e.g. http://169.254.169.254/, internal Redis),
// bypassing the SSRF guard. We re-run the SSRF check and the supplied
// authorization predicate against each Location before re-issuing the request.
//
//   isAuthorized(url) -> boolean : returns true when the host/path is allowed.
//
// Throws RedirectBlockedError if any hop fails authorization or the hop cap is
// exceeded. The caller is expected to map that to a 400/blocked response.
async function fetchWithValidatedRedirects(initialUrl, init, isAuthorized) {
  let currentUrl = new URL(initialUrl);

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const response = await fetch(currentUrl.toString(), {
      ...init,
      redirect: "manual",
    });

    if (!isRedirectStatus(response.status)) {
      return response;
    }

    const location = response.headers.get("Location");
    if (!location) {
      // A 3xx without a Location header is not actionable; return as-is.
      return response;
    }

    if (hop >= MAX_REDIRECT_HOPS) {
      throw new RedirectBlockedError(
        `Too many redirects (exceeded ${MAX_REDIRECT_HOPS} hops).`,
        currentUrl.toString(),
      );
    }

    let nextUrl;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      throw new RedirectBlockedError(
        "Redirect Location is not a valid URL.",
        location,
      );
    }

    if (nextUrl.protocol !== "https:" && nextUrl.protocol !== "http:") {
      throw new RedirectBlockedError(
        "Redirect target uses an unsupported protocol.",
        nextUrl.toString(),
      );
    }

    if (isPrivateOrLocalHost(nextUrl) || !isAuthorized(nextUrl)) {
      throw new RedirectBlockedError(
        "Redirect target is not authorized.",
        nextUrl.toString(),
      );
    }

    currentUrl = nextUrl;
  }

  // Unreachable: the loop returns or throws within MAX_REDIRECT_HOPS + 1 passes.
  throw new RedirectBlockedError(
    `Too many redirects (exceeded ${MAX_REDIRECT_HOPS} hops).`,
    currentUrl.toString(),
  );
}

function isRedirectStatus(status) {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

// ---------------------------------------------------------------------------
// ZIP proxy (shared by all archive downloads)
// ---------------------------------------------------------------------------

async function proxyGitHubZip(
  url,
  { request = null, downloadFilename = null } = {},
) {
  try {
    const headers = new Headers({
      "User-Agent": "github-proxy-worker",
      Accept: "application/zip, application/octet-stream;q=0.9, */*;q=0.8",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    });

    const forwardedRange = request?.headers?.get("Range");
    if (forwardedRange) {
      headers.set("Range", forwardedRange);
    }

    // GitHub archive/release downloads legitimately 302 to codeload.github.com
    // and objects.githubusercontent.com. Re-validate every redirect hop against
    // the GitHub host allowlist so the 302 cannot be used to reach an internal
    // or unauthorized host.
    const upstream = await fetchWithValidatedRedirects(
      url,
      { method: "GET", headers },
      isGitHubDirectProxyUrl,
    );

    if (!upstream.ok) {
      return jsonResponse(
        {
          error: "Upstream server returned an error.",
          status: upstream.status,
          statusText: upstream.statusText,
          upstream_url: url,
        },
        502,
      );
    }

    const responseHeaders = new Headers(upstream.headers);

    applyCorsHeaders(responseHeaders);
    responseHeaders.set(
      "Content-Type",
      responseHeaders.get("Content-Type") || "application/zip",
    );

    if (!responseHeaders.get("Content-Disposition")) {
      const filename = downloadFilename || buildZipFilename(new URL(url));
      responseHeaders.set(
        "Content-Disposition",
        `attachment; filename="${sanitizeFilename(filename)}"`,
      );
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    if (error instanceof RedirectBlockedError) {
      return redirectBlockedResponse(error);
    }
    return jsonResponse(
      { error: "Failed to fetch remote resource.", details: error.message },
      502,
    );
  }
}

// ---------------------------------------------------------------------------
// Legacy generic proxy mode
// ---------------------------------------------------------------------------

async function handleGenericProxy(targetUrl, request) {
  let parsedUrl;

  try {
    parsedUrl = new URL(targetUrl);
  } catch (error) {
    return jsonResponse({ error: "Invalid URL.", details: error.message }, 400);
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return jsonResponse(
      { error: "Invalid protocol. Only http and https are allowed." },
      400,
    );
  }

  parsedUrl = normalizeSupportedGenericProxyUrl(parsedUrl);

  if (!isSupportedGenericProxyUrl(parsedUrl)) {
    return jsonResponse(
      {
        error:
          "The provided URL is not a supported direct GitHub/resource URL.",
      },
      400,
    );
  }

  const translatedGitHubResponse = await maybeHandleDirectGitHubUrl(parsedUrl);
  if (translatedGitHubResponse) {
    return translatedGitHubResponse;
  }

  try {
    const upstreamHeaders = buildGenericProxyRequestHeaders(parsedUrl, request);

    // Re-validate every redirect hop against the same generic-proxy allowlist
    // (and SSRF guard) that authorized the initial URL, so an allowlisted host
    // cannot 302 us into an internal or unsupported target.
    //
    // Nextcloud/ownCloud shares are the exception: GET /s/{token}/download
    // 303-redirects to a signed DAV URL on the SAME host (e.g.
    // /public.php/dav/files/{token}/), which does not match the public-share
    // path shape. Authorize redirects that stay on the original share's host
    // instead. The SSRF guard still runs for every hop.
    //
    // Dropbox shares redirect from www.dropbox.com to dl.dropboxusercontent.com
    // (the CDN serving the actual file). Authorize that CDN host as a redirect
    // target while still running the SSRF guard.
    const isAuthorizedRedirect = isNextcloudShareUrl(parsedUrl)
      ? (candidate) => candidate.hostname === parsedUrl.hostname
      : isDropboxShareUrl(parsedUrl)
        ? (candidate) =>
            isSupportedGenericProxyUrl(candidate) || isDropboxCdnUrl(candidate)
        : isSupportedGenericProxyUrl;

    const upstream = await fetchWithValidatedRedirects(
      parsedUrl.toString(),
      { method: "GET", headers: upstreamHeaders },
      isAuthorizedRedirect,
    );

    if (!upstream.ok) {
      return jsonResponse(
        {
          error: "Upstream server returned an error.",
          status: upstream.status,
          statusText: upstream.statusText,
        },
        502,
      );
    }

    const headers = new Headers(upstream.headers);

    applyCorsHeaders(headers);
    headers.set(
      "Content-Type",
      headers.get("Content-Type") || defaultGenericContentType(parsedUrl),
    );

    if (!headers.get("Content-Disposition") && looksLikeZipUrl(parsedUrl)) {
      headers.set(
        "Content-Disposition",
        `attachment; filename="${buildZipFilename(parsedUrl)}"`,
      );
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (error) {
    if (error instanceof RedirectBlockedError) {
      return redirectBlockedResponse(error);
    }
    return jsonResponse(
      { error: "Failed to fetch remote resource.", details: error.message },
      502,
    );
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers":
      "Content-Disposition, Content-Type, Content-Length, X-Playground-Cors-Proxy",
    "Access-Control-Max-Age": "86400",
    "X-Playground-Cors-Proxy": "true",
  };
}

function applyCorsHeaders(headers) {
  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

// Maps a blocked redirect into a 400 response. A redirect into an
// unauthorized/internal target is a client-visible policy rejection, not an
// upstream failure.
function redirectBlockedResponse(error) {
  return jsonResponse(
    {
      error: "Redirect target is not an allowed proxy destination.",
      details: error.message,
    },
    400,
  );
}

function looksLikeZipUrl(url) {
  const pathname = url.pathname.toLowerCase();

  if (pathname.endsWith(".zip")) return true;
  if (pathname.includes("/zip/")) return true;
  if (pathname.includes("archive/refs/heads/")) return true;
  if (pathname.includes("archive/refs/tags/")) return true;
  if (/\/downloadbuild\/\d+\/(stable|beta)$/u.test(pathname)) return true;

  return false;
}

function isSupportedGenericProxyUrl(url) {
  // Defensive SSRF guard: never proxy private, loopback, or link-local hosts,
  // even if the path looks zip-like or otherwise matches an allowlist helper.
  if (isPrivateOrLocalHost(url)) {
    return false;
  }

  // Specific endpoint helpers authorize a URL regardless of its path shape.
  if (
    isFacturaScriptsPluginPage(url) ||
    isGitHubDirectProxyUrl(url) ||
    isGoogleDriveDirectFileUrl(url) ||
    isNextcloudShareUrl(url) ||
    isDropboxShareUrl(url) ||
    isOmekaOrgResourceUrl(url) ||
    isGitLabResourceUrl(url) ||
    isJsDelivrResourceUrl(url)
  ) {
    return true;
  }

  // A zip-like path only authorizes a request when it also targets an
  // allowlisted host. Path shape alone must never grant proxy access — that
  // would turn the worker into an open proxy / SSRF vector.
  if (looksLikeZipUrl(url) && isAllowlistedProxyHost(url)) {
    return true;
  }

  return false;
}

// Hosts that may serve zip-like downloads through the generic proxy. Specific
// endpoint helpers (GitHub, Google Drive, omeka, FacturaScripts plugin pages)
// are checked separately; this list additionally authorizes zip-only paths
// such as FacturaScripts build downloads (`/downloadbuild/{n}/{channel}`).
function isAllowlistedProxyHost(url) {
  const hostname = url.hostname.toLowerCase();

  return (
    hostname === "github.com" ||
    hostname === "codeload.github.com" ||
    hostname === "raw.githubusercontent.com" ||
    hostname === "gist.githubusercontent.com" ||
    hostname === "media.githubusercontent.com" ||
    hostname === "objects.githubusercontent.com" ||
    hostname === "release-assets.githubusercontent.com" ||
    hostname.endsWith(".githubusercontent.com") ||
    hostname === "drive.google.com" ||
    hostname === "drive.usercontent.google.com" ||
    hostname === "omeka.org" ||
    hostname === "dev.omeka.org" ||
    hostname === "facturascripts.com" ||
    hostname === "gitlab.com" ||
    hostname === "cdn.jsdelivr.net" ||
    hostname === "data.jsdelivr.com"
  );
}

// Reject hosts that resolve to private, loopback, or link-local addresses to
// avoid SSRF into internal infrastructure (cloud metadata endpoints, Redis on
// localhost, internal corp services, etc.).
function isPrivateOrLocalHost(url) {
  const hostname = url.hostname.toLowerCase();

  // Hostnames that are not numeric IPs but always resolve locally or to a
  // cloud-metadata endpoint.
  if (
    hostname === "localhost" ||
    hostname === "localhost.localdomain" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal" ||
    hostname === "metadata"
  ) {
    return true;
  }

  // IPv6 literals (URL hostname keeps the surrounding brackets).
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const ipv6 = hostname.slice(1, -1);
    if (
      ipv6 === "::1" ||
      ipv6 === "::" ||
      ipv6.startsWith("fe80:") || // link-local
      ipv6.startsWith("fc") || // unique local fc00::/7
      ipv6.startsWith("fd")
    ) {
      return true;
    }

    // IPv4-mapped IPv6 addresses (::ffff:x.x.x.x or ::ffff:HHHH:HHHH) tunnel an
    // embedded IPv4 address through an IPv6 literal. Extract the v4 address and
    // apply the same private/loopback/link-local checks so e.g.
    // [::ffff:127.0.0.1] and [::ffff:169.254.169.254] are blocked.
    const embeddedIpv4 = extractIpv4MappedAddress(ipv6);
    if (embeddedIpv4 && isPrivateIpv4(embeddedIpv4)) {
      return true;
    }

    return false;
  }

  // IPv4 literals.
  return isPrivateIpv4(hostname);
}

// Returns true when the dotted-decimal IPv4 string falls inside a private,
// loopback, or link-local range. Non-IPv4 strings return false.
function isPrivateIpv4(hostname) {
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
  if (!ipv4) {
    return false;
  }

  const octets = ipv4.slice(1).map((part) => Number(part));
  // Dead guard: an octet > 255 is not a valid IPv4 literal. Kept (rather than
  // treated as blocked) to mirror the original behavior; URL parsing already
  // rejects such hosts before they reach here.
  if (octets.some((octet) => octet > 255)) {
    return false;
  }
  const [a, b] = octets;

  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private

  return false;
}

// Extracts the embedded IPv4 address from an IPv4-mapped IPv6 literal.
// Handles both the dotted form (::ffff:127.0.0.1) and the hex form
// (::ffff:7f00:1). Returns a dotted-decimal string, or null when the input is
// not an IPv4-mapped address.
function extractIpv4MappedAddress(ipv6) {
  const lower = ipv6.toLowerCase();
  const mappedPrefix = "::ffff:";

  if (!lower.startsWith(mappedPrefix)) {
    return null;
  }

  const tail = lower.slice(mappedPrefix.length);

  // Dotted form: ::ffff:169.254.169.254
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(tail)) {
    return tail;
  }

  // Hex form: ::ffff:a9fe:a9fe -> two 16-bit groups encode the four octets.
  const hexMatch = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
  if (hexMatch) {
    const high = Number.parseInt(hexMatch[1], 16);
    const low = Number.parseInt(hexMatch[2], 16);
    const octets = [
      (high >> 8) & 0xff,
      high & 0xff,
      (low >> 8) & 0xff,
      low & 0xff,
    ];
    return octets.join(".");
  }

  return null;
}

function isGitHubDirectProxyUrl(url) {
  const hostname = url.hostname.toLowerCase();

  if (
    hostname === "github.com" ||
    hostname === "codeload.github.com" ||
    hostname === "raw.githubusercontent.com" ||
    hostname === "gist.githubusercontent.com" ||
    hostname === "media.githubusercontent.com" ||
    hostname === "objects.githubusercontent.com" ||
    hostname === "release-assets.githubusercontent.com" ||
    hostname.endsWith(".githubusercontent.com")
  ) {
    return true;
  }

  return false;
}

function isGoogleDriveDirectFileUrl(url) {
  const hostname = url.hostname.toLowerCase();

  if (hostname === "drive.google.com") {
    if (/^\/file\/d\/[^/]+(?:\/|$)/u.test(url.pathname)) {
      return true;
    }

    if (
      (url.pathname === "/uc" || url.pathname === "/open") &&
      url.searchParams.has("id")
    ) {
      return true;
    }

    return false;
  }

  if (hostname === "drive.usercontent.google.com") {
    if (url.pathname === "/download" && url.searchParams.has("id")) {
      return true;
    }

    return false;
  }

  return false;
}

// Nextcloud / ownCloud public share links live on arbitrary self-hosted
// domains, so they cannot be matched by a fixed host allowlist. Authorize them
// instead by their well-known public-share path shape:
//   /s/{token}                  (share page)
//   /s/{token}/download         (direct download; what eXeViewer requests)
//   /index.php/s/{token}[/download]   (pretty-URLs-disabled instances)
// The SSRF guard (isPrivateOrLocalHost) is still enforced for every host and
// redirect hop, so this is not an open proxy into internal infrastructure.
const NEXTCLOUD_SHARE_PATH =
  /^(?:\/index\.php)?\/s\/[A-Za-z0-9._-]+(?:\/download)?\/?$/u;

function isNextcloudShareUrl(url) {
  return NEXTCLOUD_SHARE_PATH.test(url.pathname);
}

function normalizeSupportedGenericProxyUrl(url) {
  if (isNextcloudShareUrl(url)) {
    return normalizeNextcloudShareUrl(url);
  }

  if (!isGoogleDriveDirectFileUrl(url)) {
    return url;
  }

  if (url.hostname.toLowerCase() === "drive.usercontent.google.com") {
    return url;
  }

  const normalized = new URL(url.toString());
  const fileId = extractGoogleDriveFileId(normalized);

  if (!fileId) {
    return url;
  }

  normalized.pathname = "/uc";
  normalized.search = "";

  const passthroughParams = ["confirm", "resourcekey", "uuid"];
  for (const key of passthroughParams) {
    const value = url.searchParams.get(key);
    if (value) {
      normalized.searchParams.set(key, value);
    }
  }

  normalized.searchParams.set("id", fileId);
  normalized.searchParams.set("export", "download");

  return normalized;
}

// Rewrite a bare Nextcloud/ownCloud share page (/s/{token}) to its direct
// download endpoint (/s/{token}/download). A URL that already targets /download
// (or carries a path/files query selecting a file inside a folder share) is
// returned unchanged.
function normalizeNextcloudShareUrl(url) {
  if (url.pathname.replace(/\/$/u, "").endsWith("/download")) {
    return url;
  }

  const normalized = new URL(url.toString());
  normalized.pathname = `${normalized.pathname.replace(/\/$/u, "")}/download`;

  return normalized;
}

function extractGoogleDriveFileId(url) {
  const pathMatch = url.pathname.match(/^\/file\/d\/([^/]+)(?:\/|$)/u);
  if (pathMatch?.[1]) {
    return pathMatch[1];
  }

  return url.searchParams.get("id");
}

function maybeHandleDirectGitHubUrl(url) {
  const repoMatch = matchGitHubRepoPath(url.pathname);
  if (!repoMatch) {
    return null;
  }

  const { repo, suffix } = repoMatch;

  if (suffix === "/releases.atom") {
    return handleAtomFeed(repo, "releases");
  }

  if (suffix === "/tags.atom") {
    return handleAtomFeed(repo, "tags");
  }

  // NOTE: We deliberately do NOT intercept /releases/download/{tag}/{asset}
  // URLs here. Routing them through handleReleaseAsset() means an api.github.com
  // call to resolve the asset, which fails (returns null -> 502 JSON) whenever
  // the API is rate-limited or the worker's GITHUB_TOKEN is blocked for the repo
  // (e.g. an org's fine-grained-PAT policy 404s a public repo). A complete
  // release-download URL is already an allowlisted github.com host that 302s to
  // the asset CDN, so we let handleGenericProxy fetch it directly — no API call.
  return null;
}

function matchGitHubRepoPath(pathname) {
  const match = pathname.match(/^\/([^/]+\/[^/]+)(\/.*)$/u);
  if (!match) {
    return null;
  }

  return {
    repo: match[1],
    suffix: match[2],
  };
}

function buildGenericProxyRequestHeaders(url, request) {
  const headers = new Headers();
  headers.set("User-Agent", "github-proxy-worker");
  headers.set("Cache-Control", "no-cache");
  headers.set("Pragma", "no-cache");

  const forwardedAccept = request.headers.get("Accept");
  headers.set("Accept", forwardedAccept || defaultGenericAcceptHeader(url));

  const forwardedRange = request.headers.get("Range");
  if (forwardedRange) {
    headers.set("Range", forwardedRange);
  }

  const forwardedIfNoneMatch = request.headers.get("If-None-Match");
  if (forwardedIfNoneMatch) {
    headers.set("If-None-Match", forwardedIfNoneMatch);
  }

  const forwardedIfModifiedSince = request.headers.get("If-Modified-Since");
  if (forwardedIfModifiedSince) {
    headers.set("If-Modified-Since", forwardedIfModifiedSince);
  }

  return headers;
}

function defaultGenericAcceptHeader(url) {
  if (isFacturaScriptsPluginPage(url)) {
    return "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8";
  }

  if (looksLikeZipUrl(url)) {
    return "application/zip, application/octet-stream;q=0.9, */*;q=0.8";
  }

  if (url.pathname.toLowerCase().endsWith(".atom")) {
    return "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7";
  }

  return "application/octet-stream, text/plain;q=0.9, */*;q=0.8";
}

function defaultGenericContentType(url) {
  if (looksLikeZipUrl(url)) {
    return "application/zip";
  }

  if (url.pathname.toLowerCase().endsWith(".atom")) {
    return "application/atom+xml; charset=utf-8";
  }

  if (isFacturaScriptsPluginPage(url)) {
    return "text/html; charset=utf-8";
  }

  return "application/octet-stream";
}

function isFacturaScriptsPluginPage(url) {
  return (
    url.hostname.toLowerCase() === "facturascripts.com" &&
    /^\/plugins\/[^/]+\/?$/u.test(url.pathname)
  );
}

// Dropbox shared file links: /s/{hash}/{filename} (legacy) and
// /scl/fi/{hash}/{filename} (newer secure format with rlkey+st params).
// Both formats redirect to dl.dropboxusercontent.com for the actual download.
function isDropboxShareUrl(url) {
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "www.dropbox.com" && hostname !== "dropbox.com") {
    return false;
  }
  return /^\/(?:s\/[A-Za-z0-9_-]+|scl\/fi\/[A-Za-z0-9_-]+)\//u.test(
    url.pathname,
  );
}

// Dropbox CDN — the redirect target after a successful share-link download.
function isDropboxCdnUrl(url) {
  return url.hostname.toLowerCase().endsWith(".dropboxusercontent.com");
}

function isOmekaOrgResourceUrl(url) {
  const hostname = url.hostname.toLowerCase();
  return hostname === "omeka.org" || hostname === "dev.omeka.org";
}

// GitLab repositories serve branch/tag archives and raw files. Allow the host
// for any path (mirrors how the legacy zip-proxy authorized gitlab.com).
function isGitLabResourceUrl(url) {
  return url.hostname.toLowerCase() === "gitlab.com";
}

// jsDelivr CDN (cdn.jsdelivr.net) and its package metadata API
// (data.jsdelivr.com) serve non-zip resources too, so authorize the host for
// any path rather than only zip-like paths.
function isJsDelivrResourceUrl(url) {
  const hostname = url.hostname.toLowerCase();
  return hostname === "cdn.jsdelivr.net" || hostname === "data.jsdelivr.com";
}

function buildZipFilename(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  const last = parts[parts.length - 1] || "download.zip";

  if (last.toLowerCase().endsWith(".zip")) {
    return sanitizeFilename(last);
  }

  return sanitizeFilename(`${last}.zip`);
}

function sanitizeFilename(filename) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// ---------------------------------------------------------------------------
// Landing page
// ---------------------------------------------------------------------------

function landingPageHtml(origin) {
  const base = origin || "https://your-worker.workers.dev";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GitHub Proxy</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #ffffff;
    --surface: #f6f8fa;
    --surface-hover: #eef1f5;
    --border: #d0d7de;
    --text: #1f2328;
    --text-muted: #656d76;
    --accent: #0969da;
    --accent-glow: rgba(9, 105, 218, 0.08);
    --green: #1a7f37;
    --orange: #9a6700;
    --red: #cf222e;
    --mono: 'JetBrains Mono', monospace;
    --sans: 'DM Sans', system-ui, sans-serif;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: var(--sans);
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    line-height: 1.6;
  }

  .hero {
    text-align: center;
    padding: 5rem 1.5rem 3rem;
    position: relative;
  }

  .hero::before {
    content: '';
    position: absolute;
    top: 0; left: 50%;
    transform: translateX(-50%);
    width: 600px; height: 600px;
    background: radial-gradient(circle, var(--accent-glow) 0%, transparent 70%);
    pointer-events: none;
    z-index: 0;
  }

  .hero > * { position: relative; z-index: 1; }

  .logo {
    display: inline-flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1.5rem;
  }

  .logo svg {
    width: 48px; height: 48px;
    color: var(--accent);
  }

  h1 {
    font-family: var(--mono);
    font-size: clamp(2rem, 5vw, 3.5rem);
    font-weight: 700;
    letter-spacing: -0.02em;
    margin-bottom: 0.75rem;
  }

  .subtitle {
    color: var(--text-muted);
    font-size: 1.15rem;
    max-width: 600px;
    margin: 0 auto 1.5rem;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 2rem;
    padding: 0.4rem 1rem;
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .badge a {
    color: var(--accent);
    text-decoration: none;
  }

  .badge a:hover { text-decoration: underline; }

  .container {
    max-width: 820px;
    margin: 0 auto;
    padding: 0 1.5rem 4rem;
    flex: 1;
  }

  .section-title {
    font-family: var(--mono);
    font-size: 0.8rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--accent);
    margin-bottom: 1.25rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border);
  }

  .endpoints {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-bottom: 3rem;
  }

  .endpoint {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem 1.25rem;
    transition: border-color 0.2s, background 0.2s;
    cursor: default;
  }

  .endpoint:hover {
    border-color: var(--accent);
    background: var(--surface-hover);
  }

  .endpoint-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.5rem;
  }

  .method {
    font-family: var(--mono);
    font-size: 0.7rem;
    font-weight: 700;
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    background: rgba(26, 127, 55, 0.1);
    color: var(--green);
    flex-shrink: 0;
  }

  .endpoint-name {
    font-family: var(--mono);
    font-weight: 500;
    font-size: 0.95rem;
  }

  .endpoint-desc {
    color: var(--text-muted);
    font-size: 0.875rem;
    margin-left: calc(0.7rem + 0.5rem * 2 + 0.75rem); /* align with name */
  }

  .url-box {
    font-family: var(--mono);
    font-size: 0.8rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.6rem 0.9rem;
    margin-top: 0.5rem;
    margin-left: calc(0.7rem + 0.5rem * 2 + 0.75rem);
    color: var(--text-muted);
    overflow-x: auto;
    white-space: nowrap;
    user-select: all;
  }

  .url-box .param {
    color: var(--orange);
  }

  .url-box .optional {
    color: var(--text-muted);
    opacity: 0.6;
  }

  footer {
    text-align: center;
    padding: 2rem 1.5rem;
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  footer a {
    color: var(--accent);
    text-decoration: none;
  }

  footer a:hover { text-decoration: underline; }

  @media (max-width: 640px) {
    .hero { padding: 3rem 1rem 2rem; }
    .endpoint-desc, .url-box { margin-left: 0; }
  }
</style>
</head>
<body>

<div class="hero">
  <div class="logo">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>
    </svg>
    <span style="font-family:var(--mono);font-size:1.1rem;font-weight:700;color:var(--text-muted)">PROXY</span>
  </div>
  <h1>GitHub Proxy</h1>
  <p class="subtitle">
    A CORS-friendly proxy for GitHub archive files, release assets and Atom feeds.
    Intended as a drop-in replacement for <code style="color:var(--accent)">github-proxy.com</code>.
  </p>
  <div class="badge">
    &#x1F4D6; Background:
    <a href="https://make.wordpress.org/playground/2025/12/19/action-required-github-proxy-com-shutdown/" target="_blank" rel="noopener">
      github-proxy.com shutdown notice
    </a>
  </div>
</div>

<div class="container">
  <div class="section-title">Archive Downloads</div>
  <div class="endpoints">

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method">GET</span>
        <span class="endpoint-name">Branch</span>
      </div>
      <div class="endpoint-desc">Download a full branch. Resolves the default branch when none is specified.</div>
      <div class="url-box">${base}/?repo=<span class="param">{owner/repo}</span><span class="optional">[&amp;branch=<span class="param">{branch}</span>]</span></div>
    </div>

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method">GET</span>
        <span class="endpoint-name">Pull Request</span>
      </div>
      <div class="endpoint-desc">Download the code for a pull request by its number.</div>
      <div class="url-box">${base}/?repo=<span class="param">{owner/repo}</span>&amp;pr=<span class="param">{number}</span></div>
    </div>

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method">GET</span>
        <span class="endpoint-name">Commit</span>
      </div>
      <div class="endpoint-desc">Download the code at a specific commit SHA.</div>
      <div class="url-box">${base}/?repo=<span class="param">{owner/repo}</span>&amp;commit=<span class="param">{sha}</span></div>
    </div>

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method">GET</span>
        <span class="endpoint-name">Release</span>
      </div>
      <div class="endpoint-desc">Download the source archive for a tagged release.</div>
      <div class="url-box">${base}/?repo=<span class="param">{owner/repo}</span>&amp;release=<span class="param">{tag}</span></div>
    </div>

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method">GET</span>
        <span class="endpoint-name">Release Asset</span>
      </div>
      <div class="endpoint-desc">Download a specific asset file attached to a release.</div>
      <div class="url-box">${base}/?repo=<span class="param">{owner/repo}</span>&amp;release=<span class="param">{tag}</span>&amp;asset=<span class="param">{filename}</span></div>
    </div>

  </div>

  <div class="section-title">Atom Feeds</div>
  <div class="endpoints">

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method">GET</span>
        <span class="endpoint-name">Releases Feed</span>
      </div>
      <div class="endpoint-desc">Atom feed of a repository's releases.</div>
      <div class="url-box">${base}/?repo=<span class="param">{owner/repo}</span>&amp;atom=<span class="param">releases</span></div>
    </div>

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method">GET</span>
        <span class="endpoint-name">Tags Feed</span>
      </div>
      <div class="endpoint-desc">Atom feed of a repository's tags.</div>
      <div class="url-box">${base}/?repo=<span class="param">{owner/repo}</span>&amp;atom=<span class="param">tags</span></div>
    </div>

  </div>

  <div class="section-title">Generic Proxy (Legacy)</div>
  <div class="endpoints">

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method">GET</span>
        <span class="endpoint-name">URL Proxy</span>
      </div>
      <div class="endpoint-desc">Proxy supported ZIP, GitHub resource, Google Drive, Nextcloud / ownCloud share, or omeka.org / dev.omeka.org URLs with CORS headers.</div>
      <div class="endpoint-desc">Drive accepts direct <code>/uc?id=...</code> links and shared <code>/file/d/{id}/view</code> links.</div>
      <div class="endpoint-desc">Nextcloud / ownCloud accepts public share links <code>/s/{token}</code> and <code>/s/{token}/download</code> on any host.</div>
      <div class="url-box">${base}/?url=<span class="param">{full_url}</span></div>
    </div>

  </div>
</div>

<footer>
  Built as an alternative after the
  <a href="https://make.wordpress.org/playground/2025/12/19/action-required-github-proxy-com-shutdown/" target="_blank" rel="noopener">github-proxy.com shutdown</a>.
  Powered by <a href="https://workers.cloudflare.com/" target="_blank" rel="noopener">Cloudflare Workers</a>.
</footer>

</body>
</html>`;
}
